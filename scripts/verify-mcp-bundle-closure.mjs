import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

export const bundledPackages = {
  "@asteasolutions/zod-to-openapi": "9.1.0",
  "@hono/zod-openapi": "1.6.1",
  "@hono/zod-validator": "0.9.0",
  "@modelcontextprotocol/sdk": "1.25.3",
  "@noble/ciphers": "2.4.0",
  "@noble/curves": ["2.0.1", "2.4.0"],
  "@noble/hashes": ["2.0.1", "2.4.0"],
  "@noble/post-quantum": "0.5.4",
  "@scure/base": "2.4.0",
  "age-encryption": "0.3.1",
  "ajv": "8.20.0",
  "ajv-formats": "3.0.1",
  "fast-deep-equal": "3.1.3",
  "fast-uri": "3.1.6",
  "hono": "4.13.3",
  "json-schema-traverse": "1.0.0",
  "zod": "4.1.8",
  "zod-to-json-schema": "3.25.2",
}

const bundledPackageLicenses = {
  "@asteasolutions/zod-to-openapi": "MIT",
  "@hono/zod-openapi": "MIT",
  "@hono/zod-validator": "MIT",
  "@modelcontextprotocol/sdk": "MIT",
  "@noble/ciphers": "MIT",
  "@noble/curves": "MIT",
  "@noble/hashes": "MIT",
  "@noble/post-quantum": "MIT",
  "@scure/base": "MIT",
  "age-encryption": "BSD-3-Clause",
  "ajv": "MIT",
  "ajv-formats": "MIT",
  "fast-deep-equal": "MIT",
  "fast-uri": "BSD-3-Clause",
  "hono": "MIT",
  "json-schema-traverse": "MIT",
  "zod": "MIT",
  "zod-to-json-schema": "ISC",
}

const licenseNoticeHeadings = {
  MIT: "## MIT-Licensed Packages",
  "BSD-3-Clause": "## BSD-3-Clause Packages",
  ISC: "## ISC-Licensed Package",
}

const requiredLicenseTerms = {
  MIT: [
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.",
    "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND",
  ],
  "BSD-3-Clause": [
    "Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:",
    "Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software",
    "THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS \"AS IS\"",
  ],
  ISC: [
    "Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted",
    "THE SOFTWARE IS PROVIDED \"AS IS\" AND THE AUTHOR DISCLAIMS ALL WARRANTIES",
  ],
}

const requiredCopyrights = {
  "@asteasolutions/zod-to-openapi": "copyright (c) 2022 Astea Solutions",
  "@hono/zod-openapi": "copyright (c) 2021-present Yusuke Wada and Hono contributors",
  "@hono/zod-validator": "copyright (c) 2021-present Yusuke Wada and Hono contributors",
  "@modelcontextprotocol/sdk": "copyright (c) 2024 Anthropic, PBC",
  "@noble/ciphers": "copyright (c) 2022 Paul Miller",
  "@noble/curves": "copyright (c) 2022 Paul Miller",
  "@noble/hashes": "copyright (c) 2022 Paul Miller",
  "@noble/post-quantum": "copyright (c) 2024 Paul Miller",
  "@scure/base": "copyright (c) 2022 Paul Miller",
  "age-encryption": "copyright 2023 The age Authors",
  ajv: "copyright (c) 2015-2021 Evgeny Poberezkin",
  "ajv-formats": "copyright (c) 2020 Evgeny Poberezkin",
  "fast-deep-equal": "copyright (c) 2017 Evgeny Poberezkin",
  "fast-uri": "copyright (c) 2011-2021 Gary Court",
  hono: "copyright (c) 2021-present Yusuke Wada and Hono contributors",
  "json-schema-traverse": "copyright (c) 2017 Evgeny Poberezkin",
  zod: "copyright (c) 2025 Colin McDonnell",
  "zod-to-json-schema": "copyright (c) 2020 Stefan Terdell",
}

export async function verifyBundleClosure(root, metafiles) {
  const actual = new Map()
  const packageRoots = new Map()
  const inputs = metafiles.flatMap(metafile => Object.keys(metafile.inputs))
  for (const required of ["packages/control-plane-local/src/vendor/friendly-words/predicates.txt", "packages/control-plane-local/src/vendor/friendly-words/objects.txt", "packages/sandbox-runtime/src/vendor/opencode-edit.ts", "packages/sandbox-runtime/src/vendor/opencode-patch.ts"]) {
    if (!inputs.some(input => input.endsWith(required))) throw new Error(`Expected reviewed bundled source is absent: ${required}`)
  }
  for (const input of inputs) {
    if (input.includes("packages/receiver/src/vendor/")) throw new Error(`Obsolete receiver vendor source entered the MCP bundle: ${input}`)
    if (!input.includes("node_modules/")) continue
    const match = /node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//.exec(input)
    if (!match) throw new Error(`Cannot identify bundled package input: ${input}`)
    const packageName = match[1]
    const versionMatch = /node_modules\/\.bun\/(?:@[^+]+\+)?([^@/]+)@([^+/]+)/.exec(input)
    if (!versionMatch) throw new Error(`Cannot identify bundled package version: ${input}`)
    const versions = actual.get(packageName) ?? new Set()
    versions.add(versionMatch[2])
    actual.set(packageName, versions)
    const packageRootMatch = new RegExp(`^(.*node_modules/${packageName.replace("/", "\\/")})/`).exec(input)
    if (!packageRootMatch) throw new Error(`Cannot identify bundled package root: ${input}`)
    packageRoots.set(`${packageName}@${versionMatch[2]}`, packageRootMatch[1])
  }

  const expected = new Map(Object.entries(bundledPackages).map(([name, versions]) => [name, new Set(Array.isArray(versions) ? versions : [versions])]))
  if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected))) {
    throw new Error(`MCP bundle license closure changed. Expected ${JSON.stringify(normalize(expected))}; received ${JSON.stringify(normalize(actual))}`)
  }

  const notice = await readFile(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8")
  const normalizedNotice = notice.replace(/\s+/g, " ")
  for (const [name, versions] of expected) {
    for (const version of versions) {
      if (!notice.includes(`\`${name}@${version}\``)) throw new Error(`THIRD_PARTY_NOTICES.md does not cover ${name}@${version}`)
      const manifest = JSON.parse(await readFile(resolve(root, packageRoots.get(`${name}@${version}`), "package.json"), "utf8"))
      if (manifest.name !== name || manifest.version !== version || manifest.license !== bundledPackageLicenses[name]) throw new Error(`Reviewed license identity changed for ${name}@${version}`)
      if (!notice.includes(licenseNoticeHeadings[manifest.license])) throw new Error(`THIRD_PARTY_NOTICES.md does not include the reviewed ${manifest.license} terms for ${name}@${version}`)
      for (const term of requiredLicenseTerms[manifest.license]) if (!normalizedNotice.includes(term)) throw new Error(`THIRD_PARTY_NOTICES.md has incomplete ${manifest.license} terms for ${name}@${version}`)
      const noticeLine = notice.split("\n").find(line => line.includes(`\`${name}@${version}\``))
      if (!noticeLine?.includes(requiredCopyrights[name])) throw new Error(`THIRD_PARTY_NOTICES.md has incomplete copyright attribution for ${name}@${version}`)
    }
  }
  for (const requiredSource of ["f94b4639c71c26875f7684fa86a214c7f30deaad", "c29a7c152da09e2828e9529a21d979d6f4d6a120"]) {
    if (!notice.includes(requiredSource)) throw new Error(`THIRD_PARTY_NOTICES.md does not cover bundled source ${requiredSource}`)
  }
}

function normalize(value) {
  return [...value].map(([name, versions]) => [name, [...versions].sort()]).sort(([left], [right]) => left.localeCompare(right))
}
