import {
  CreateRoleCommand,
  GetRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
  TagRoleCommand,
} from "@aws-sdk/client-iam";
import {
  CreateMicrovmImageCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListManagedMicrovmImagesCommand,
  ListMicrovmImagesCommand,
  UpdateMicrovmImageCommand,
  type CreateMicrovmImageRequest,
} from "@aws-sdk/client-lambda-microvms";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketTaggingCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { fromIni } from "@aws-sdk/credential-providers";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");
const STATE_DIR = resolve(ROOT, ".oc-remote");
const BUILD_DIR = resolve(STATE_DIR, "build");
const RECEIVER_ENTRY = resolve(ROOT, "packages/receiver/src/server.ts");
const RECEIVER_BUNDLE = resolve(BUILD_DIR, "server.js");
const RECEIVER_DOCKERFILE = resolve(ROOT, "packages/receiver/Dockerfile");
const ARTIFACT = resolve(BUILD_DIR, "receiver.zip");
const IMAGE_NAME = process.env.OC_REMOTE_IMAGE_NAME ?? "oc-remote-receiver";
const MINIMUM_MEMORY_MIB = 8_192;
const ROLE_NAME = process.env.OC_REMOTE_BUILD_ROLE ?? "oc-remote-microvm-image-builder";
const POLICY_NAME = "oc-remote-artifact-access";
const TAGS = { Project: "oc-remote", ManagedBy: "scripts/deploy.ts" };

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null || value === "") throw new Error(`AWS did not return ${label}`);
  return value;
}

function run(command: string, args: string[], cwd = ROOT): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function awsErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name?.replace(/Exception$/, "") ?? candidate.$metadata?.httpStatusCode?.toString();
}

async function ensureBucket(s3: S3Client, bucket: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const code = awsErrorCode(error);
    if (!['404', "NotFound", "NoSuchBucket"].includes(code ?? "")) throw error;
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  await s3.send(new PutBucketTaggingCommand({
    Bucket: bucket,
    Tagging: { TagSet: Object.entries(TAGS).map(([Key, Value]) => ({ Key, Value })) },
  }));
}

async function ensureBuildRole(iam: IAMClient, bucket: string, artifactKey: string): Promise<string> {
  let roleArn: string;
  let created = false;
  try {
    const result = await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
    roleArn = required(result.Role?.Arn, "the build role ARN");
  } catch (error) {
    if (awsErrorCode(error) !== "NoSuchEntity") throw error;
    const result = await iam.send(new CreateRoleCommand({
      RoleName: ROLE_NAME,
      Description: "Allows Lambda MicroVM image builds to read oc-remote artifacts",
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
          Action: ["sts:AssumeRole", "sts:TagSession"],
        }],
      }),
      Tags: Object.entries(TAGS).map(([Key, Value]) => ({ Key, Value })),
    }));
    roleArn = required(result.Role?.Arn, "the created build role ARN");
    created = true;
  }

  await iam.send(new PutRolePolicyCommand({
    RoleName: ROLE_NAME,
    PolicyName: POLICY_NAME,
    PolicyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "ReadArtifact",
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:GetObjectVersion"],
          Resource: `arn:aws:s3:::${bucket}/${artifactKey}`,
        },
        {
          Sid: "WriteLogs",
          Effect: "Allow",
          Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
          Resource: "*",
        },
      ],
    }),
  }));
  await iam.send(new TagRoleCommand({
    RoleName: ROLE_NAME,
    Tags: Object.entries(TAGS).map(([Key, Value]) => ({ Key, Value })),
  }));
  // IAM role creation is eventually consistent with services assuming the role.
  if (created) await Bun.sleep(10_000);
  return roleArn;
}

async function findBaseImage(client: LambdaMicrovmsClient): Promise<string> {
  if (process.env.OC_REMOTE_BASE_IMAGE_ARN) return process.env.OC_REMOTE_BASE_IMAGE_ARN;

  let nextToken: string | undefined;
  do {
    const page = await client.send(new ListManagedMicrovmImagesCommand({ nextToken, maxResults: 50 }));
    const match = page.items?.find((item) => /al2023|amazon-linux-2023/i.test(item.imageArn ?? ""));
    if (match?.imageArn) return match.imageArn;
    nextToken = page.nextToken;
  } while (nextToken);

  throw new Error(
    "No AL2023 managed MicroVM image was returned. Set OC_REMOTE_BASE_IMAGE_ARN to its managed image ARN.",
  );
}

async function findImage(client: LambdaMicrovmsClient): Promise<string | undefined> {
  let nextToken: string | undefined;
  do {
    const page = await client.send(new ListMicrovmImagesCommand({
      nameFilter: IMAGE_NAME,
      maxResults: 50,
      nextToken,
    }));
    const image = page.items?.find((item) => item.name === IMAGE_NAME);
    if (image?.imageArn) return image.imageArn;
    nextToken = page.nextToken;
  } while (nextToken);
  return undefined;
}

async function waitForImage(
  client: LambdaMicrovmsClient,
  imageIdentifier: string,
  imageVersion: string,
): Promise<string> {
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const image = await client.send(new GetMicrovmImageCommand({ imageIdentifier }));
    process.stdout.write(`Image ${image.state ?? "UNKNOWN"}\r`);
    if (
      (image.state === "CREATED" || image.state === "UPDATED") &&
      image.latestActiveImageVersion === imageVersion
    ) {
      process.stdout.write("\n");
      return image.latestActiveImageVersion;
    }
    if (image.state === "CREATE_FAILED" || image.state === "UPDATE_FAILED") {
      const version = await client.send(new GetMicrovmImageVersionCommand({ imageIdentifier, imageVersion }));
      throw new Error(`MicroVM image build failed: ${version.stateReason ?? image.state}`);
    }
    await Bun.sleep(5_000);
  }
  throw new Error("Timed out after 30 minutes waiting for the MicroVM image build");
}

async function main(): Promise<void> {
  const profile = option("profile") ?? process.env.AWS_PROFILE ?? "playground";
  const region = option("region") ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const credentials = fromIni({ profile });
  const clientConfig = { region, credentials };
  const sts = new STSClient(clientConfig);
  const s3 = new S3Client(clientConfig);
  const iam = new IAMClient(clientConfig);
  const microvms = new LambdaMicrovmsClient(clientConfig);

  await rm(BUILD_DIR, { recursive: true, force: true });
  await mkdir(BUILD_DIR, { recursive: true });
  run("bun", ["build", RECEIVER_ENTRY, "--outfile", RECEIVER_BUNDLE, "--target", "node", "--format", "esm"]);
  await copyFile(RECEIVER_DOCKERFILE, resolve(BUILD_DIR, "Dockerfile"));
  run("zip", ["-q", ARTIFACT, "Dockerfile", "server.js"], BUILD_DIR);

  const body = await readFile(ARTIFACT);
  const digest = createHash("sha256").update(body).digest("hex");
  const clientToken = createHash("sha256")
    .update(`${digest}:${MINIMUM_MEMORY_MIB}`)
    .digest("hex");
  const account = required((await sts.send(new GetCallerIdentityCommand({}))).Account, "the AWS account ID");
  const bucket = `oc-remote-artifacts-${account}-${region}`.toLowerCase();
  const artifactKey = `receiver/${digest}.zip`;

  await ensureBucket(s3, bucket);
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: artifactKey,
    Body: body,
    ContentType: "application/zip",
    Metadata: { sha256: digest },
  }));
  const buildRoleArn = await ensureBuildRole(iam, bucket, artifactKey);
  const baseImageArn = await findBaseImage(microvms);
  const imageConfig: Omit<CreateMicrovmImageRequest, "name"> = {
    baseImageArn,
    buildRoleArn,
    description: "oc-remote receiver on Amazon Linux 2023",
    codeArtifact: { uri: `s3://${bucket}/${artifactKey}` },
    cpuConfigurations: [{ architecture: "ARM_64" }],
    resources: [{ minimumMemoryInMiB: MINIMUM_MEMORY_MIB }],
    hooks: {
      port: 8080,
      microvmHooks: { run: "ENABLED", runTimeoutInSeconds: 60 },
      microvmImageHooks: { ready: "ENABLED", readyTimeoutInSeconds: 60 },
    },
    logging: { cloudWatch: {} },
    tags: TAGS,
    clientToken,
  };

  const existingImage = await findImage(microvms);
  let imageIdentifier: string;
  let imageVersion: string;
  if (existingImage) {
    const result = await microvms.send(new UpdateMicrovmImageCommand({
      ...imageConfig,
      imageIdentifier: existingImage,
    }));
    imageIdentifier = required(result.imageArn, "the updated image ARN");
    imageVersion = required(result.imageVersion, "the updated image version");
  } else {
    const result = await microvms.send(new CreateMicrovmImageCommand({
      ...imageConfig,
      name: IMAGE_NAME,
    }));
    imageIdentifier = required(result.imageArn, "the created image ARN");
    imageVersion = required(result.imageVersion, "the created image version");
  }

  imageVersion = await waitForImage(microvms, imageIdentifier, imageVersion);
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(
    resolve(STATE_DIR, "deployment.json"),
    `${JSON.stringify({ profile, region, imageIdentifier, imageVersion }, null, 2)}\n`,
  );
  console.log(`Deployed ${imageIdentifier}:${imageVersion}`);
}

await main();
