import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { fromIni } from "@aws-sdk/credential-providers";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TOOL_PATHS } from "../packages/protocol/src/index.ts";

interface Deployment {
  profile: string;
  region: string;
  imageIdentifier: string;
  imageVersion: string;
}

const deploymentPath = resolve(import.meta.dir, "../.oc-remote/deployment.json");

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`AWS did not return ${label}`);
  return value;
}

async function request(
  endpoint: string,
  authToken: Record<string, string>,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const base = endpoint.includes("://") ? endpoint : `https://${endpoint}`;
  const response = await fetch(new URL(path, `${base.replace(/\/$/, "")}/`), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...authToken,
      "X-aws-proxy-port": "8080",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text}`);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function bash(
  endpoint: string,
  authToken: Record<string, string>,
  body: unknown,
): Promise<Record<string, unknown>> {
  const value = await request(endpoint, authToken, "/v1/tools/bash", body);
  if (typeof value !== "string") throw new Error("bash returned a non-stream response");
  const events = value.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const result = [...events].reverse().find((event) => event.type === "result");
  if (!result) throw new Error("bash stream ended without a result event");
  return result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid response`);
  }
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  const deployment = JSON.parse(await readFile(deploymentPath, "utf8")) as Deployment;
  const client = new LambdaMicrovmsClient({
    region: deployment.region,
    credentials: fromIni({ profile: deployment.profile }),
  });
  let microvmId: string | undefined;

  try {
    const run = await client.send(new RunMicrovmCommand({
      imageIdentifier: deployment.imageIdentifier,
      imageVersion: deployment.imageVersion,
      maximumDurationInSeconds: 900,
      ingressNetworkConnectors: [
        `arn:aws:lambda:${deployment.region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
      ],
      egressNetworkConnectors: [
        `arn:aws:lambda:${deployment.region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
      ],
    }));
    microvmId = required(run.microvmId, "the MicroVM ID");
    let endpoint = run.endpoint;
    let running = run.state === "RUNNING";

    const deadline = Date.now() + 5 * 60_000;
    while (!running && Date.now() < deadline) {
      await Bun.sleep(2_000);
      const current = await client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
      if (current.state === "TERMINATED" || current.state === "TERMINATING") {
        throw new Error(`MicroVM terminated while starting: ${current.stateReason ?? current.state}`);
      }
      endpoint = current.endpoint ?? endpoint;
      running = current.state === "RUNNING";
    }
    if (!running) throw new Error("MicroVM did not enter RUNNING state within 5 minutes");
    if (!endpoint) throw new Error("AWS did not return the MicroVM endpoint");

    const token = await client.send(new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: microvmId,
      expirationInMinutes: 10,
      allowedPorts: [{ port: 8080 }],
    }));
    const authToken = token.authToken;
    if (!authToken || Object.keys(authToken).length === 0) throw new Error("AWS did not return a port auth token");

    let healthy = false;
    const healthDeadline = Date.now() + 5 * 60_000;
    while (Date.now() < healthDeadline) {
      try {
        await request(endpoint, authToken, "/health");
        healthy = true;
        break;
      } catch {
        await Bun.sleep(2_000);
      }
    }
    if (!healthy) throw new Error("Receiver did not become healthy within 5 minutes");

    const clone = await bash(endpoint, authToken, {
      command: "git clone --depth 1 https://github.com/octocat/Hello-World.git /workspace/hello-world",
    });
    const cloneMetadata = record(clone.metadata, "bash metadata");
    if (cloneMetadata.exitCode !== 0) throw new Error(`git clone failed: ${String(clone.output ?? "")}`);

    const marker = `oc-remote-smoke-${crypto.randomUUID()}`;
    const smokePath = "/workspace/hello-world/.oc-remote-smoke.txt";
    await request(endpoint, authToken, TOOL_PATHS.write, {
      filePath: smokePath,
      content: `${marker}\nstatus: pending\n`,
    });
    const read = record(await request(endpoint, authToken, TOOL_PATHS.read, {
      filePath: smokePath,
    }), TOOL_PATHS.read);
    if (read.output !== `${marker}\nstatus: pending`) {
      throw new Error(`read/write persistence check failed: got ${String(read.output)}`);
    }

    const glob = record(await request(endpoint, authToken, TOOL_PATHS.glob, {
      pattern: ".oc-remote-smoke.txt",
      path: "/workspace/hello-world",
    }), TOOL_PATHS.glob);
    if (!String(glob.output).includes("hello-world/.oc-remote-smoke.txt")) {
      throw new Error(`glob did not find the smoke file: ${String(glob.output)}`);
    }

    const grep = record(await request(endpoint, authToken, TOOL_PATHS.grep, {
      pattern: marker,
      path: "/workspace/hello-world",
      include: "*.txt",
    }), TOOL_PATHS.grep);
    if (!String(grep.output).includes(marker)) {
      throw new Error(`grep did not find the smoke marker: ${String(grep.output)}`);
    }

    await request(endpoint, authToken, TOOL_PATHS.edit, {
      filePath: smokePath,
      oldString: "status: pending",
      newString: "status: edited",
    });

    await request(endpoint, authToken, TOOL_PATHS.patch, {
      patchText: `*** Begin Patch\n*** Update File: hello-world/.oc-remote-smoke.txt\n@@\n-status: edited\n+status: patched\n*** Add File: hello-world/.oc-remote-patch.txt\n+${marker}\n*** End Patch`,
    });

    const patched = record(await request(endpoint, authToken, TOOL_PATHS.read, {
      filePath: smokePath,
    }), TOOL_PATHS.read);
    if (patched.output !== `${marker}\nstatus: patched`) {
      throw new Error(`edit/patch persistence check failed: got ${String(patched.output)}`);
    }
    console.log(`Smoke test passed on ${microvmId}`);
  } finally {
    if (microvmId) {
      try {
        await client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
        console.log(`Terminated ${microvmId}`);
      } catch (error) {
        console.error(`Failed to terminate ${microvmId}:`, error);
      }
    }
  }
}

await main();
