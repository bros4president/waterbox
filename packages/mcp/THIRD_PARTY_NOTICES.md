# Third-Party Notices

Waterbox bundles the following third-party packages in `dist/waterbox.js` or
`dist/waterbox-cli.js`. Versions are the exact versions in the reviewed build
closure. The build fails if that closure changes without updating this file.

## MIT-Licensed Packages

- `@asteasolutions/zod-to-openapi@9.1.0`, copyright (c) 2022 Astea Solutions.
- `@hono/zod-openapi@1.6.1`, `@hono/zod-validator@0.9.0`, and `hono@4.13.3`, copyright (c) 2021-present Yusuke Wada and Hono contributors.
- `@modelcontextprotocol/sdk@1.25.3`, copyright (c) 2024 Anthropic, PBC.
- `@noble/ciphers@2.4.0`, copyright (c) 2022 Paul Miller and copyright (c) 2016 Thomas Pornin.
- `@noble/curves@2.0.1` and `@noble/curves@2.4.0`, copyright (c) 2022 Paul Miller.
- `@noble/hashes@2.0.1` and `@noble/hashes@2.4.0`, copyright (c) 2022 Paul Miller.
- `@noble/post-quantum@0.5.4`, copyright (c) 2024 Paul Miller.
- `@scure/base@2.4.0`, copyright (c) 2022 Paul Miller.
- `ajv@8.20.0`, copyright (c) 2015-2021 Evgeny Poberezkin.
- `ajv-formats@3.0.1`, copyright (c) 2020 Evgeny Poberezkin.
- `fast-deep-equal@3.1.3` and `json-schema-traverse@1.0.0`, copyright (c) 2017 Evgeny Poberezkin.
- `zod@4.1.8`, copyright (c) 2025 Colin McDonnell.

Required notice text for the packages above:

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## BSD-3-Clause Packages

- `age-encryption@0.3.1`, copyright 2023 The age Authors.
- `fast-uri@3.1.6`, copyright (c) 2011-2021 Gary Court and copyright (c) 2021-present The Fastify team.

Required notice text for the packages above:

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the applicable copyright
   notice above, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

## ISC-Licensed Package

- `zod-to-json-schema@3.25.2`, copyright (c) 2020 Stefan Terdell.

Required notice text:

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

## Glitch Friendly Words

The readable-ID corpora in
`packages/control-plane-local/src/vendor/friendly-words/` are copied from
[glitchdotcom/friendly-words](https://github.com/glitchdotcom/friendly-words)
commit `f94b4639c71c26875f7684fa86a214c7f30deaad`.

MIT License. Copyright (c) 2018 Glitch. The MIT terms above apply.

## anomalyco/opencode

The files `packages/sandbox-runtime/src/vendor/opencode-patch.ts` and
`packages/sandbox-runtime/src/vendor/opencode-edit.ts` contain code adapted
from [anomalyco/opencode](https://github.com/anomalyco/opencode) commit
`c29a7c152da09e2828e9529a21d979d6f4d6a120`.

MIT License. Copyright (c) 2025 opencode. The MIT terms above apply.

`@inquirer/prompts@7.8.6` and `@napi-rs/keyring@2.0.0` remain external runtime
dependencies and are not included in either Waterbox JavaScript bundle. Their
npm package manifests identify compatible MIT licenses.
