# Third-Party Notices

This distribution can include the following optional automatic-timing
components. This inventory is versioned with Mazzy 1.0.0 and is not a legal
opinion about training datasets or downstream use.

## Production JavaScript/audio dependencies

- React 19.2.4, React DOM 19.2.4, and Scheduler 0.27.0 — MIT —
  Copyright (c) Meta Platforms, Inc. and affiliates.
- Tone.js 15.1.22 — MIT — Copyright (c) 2014-2020 Yotam Mann.
- music-tempo 1.0.3 — MIT — Copyright (c) 2017 killercrush.
- standardized-audio-context 25.3.77 — MIT — Copyright (c) Chris Guttandin.
- WaveSurfer.js 7.12.5 — BSD-3-Clause — Copyright (c) 2012-2023,
  katspaugh and contributors.
- Signalsmith Stretch Web 1.3.2 — MIT — Copyright (c) 2022 Geraint Luff / Signalsmith Audio Ltd. and
  contributors. It is currently bundled only for the key-lock benchmark spike;
  it does not grant production phrase-blend eligibility.
- ONNX Runtime browser transitives: FlatBuffers 25.9.23 and long 5.3.2 —
  Apache-2.0; protobufjs 7.6.5 and its `@protobufjs/*` runtime helpers —
  BSD-3-Clause, Copyright (c) 2016 Daniel Wirtz; guid-typescript 1.0.9 —
  ISC; tslib 2.8.1 — 0BSD, Copyright (c) Microsoft Corporation.
- Other production runtime transitives reported by `npm ls --omit=dev --all`:
  `@babel/runtime@7.29.2`, `automation-events@7.1.16`, and
  `platform@1.3.6` — MIT. Type-only packages are present in the install tree but
  do not contribute executable browser code.

The MIT dependencies above are provided under the following terms:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The applicable copyright notice and this permission notice shall be included
> in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

WaveSurfer.js is provided under the BSD 3-Clause License:

> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
>
> 1. Redistributions of source code must retain the above copyright notice,
> this list of conditions and the following disclaimer.
> 2. Redistributions in binary form must reproduce the above copyright notice,
> this list of conditions and the following disclaimer in the documentation
> and/or other materials provided with the distribution.
> 3. Neither the name of the copyright holder nor the names of its contributors
> may be used to endorse or promote products derived from this software without
> specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
> AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
> IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
> ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
> LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
> CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
> SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
> INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
> CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
> ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
> POSSIBILITY OF SUCH DAMAGE.

The same BSD 3-Clause terms apply to protobufjs and its runtime helpers, with
Copyright (c) 2016, Daniel Wirtz.

FlatBuffers and long are provided under the Apache License, Version 2.0. The
complete license text is distributed as [`APACHE-2.0.txt`](./APACHE-2.0.txt).

guid-typescript is provided under the ISC License: permission to use, copy,
modify, and/or distribute the software for any purpose with or without fee is
granted, provided that its copyright and permission notices appear in all
copies. The software is provided “as is” without warranty.

tslib is provided under the 0BSD License:

> Copyright (c) Microsoft Corporation.
>
> Permission to use, copy, modify, and/or distribute this software for any
> purpose with or without fee is hereby granted.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
> REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
> AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
> INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
> LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
> OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
> PERFORMANCE OF THIS SOFTWARE.

## Beat This `final0` model and preprocessing artifacts

- Project: Beat This! Accurate Beat Tracking Without DBN Postprocessing
- Source: https://github.com/CPJKU/beat_this
- Model export source: https://huggingface.co/musetric/beat-this-onnx
- Prepared from revision: `4e971bd43753023e1bf961c34a0cb74985cfcb88`
- Included artifacts: `beat_this.onnx`, `config.json`, `mel-filterbank.bin`
- License: MIT

> Copyright (c) 2024 Institute of Computational Perception, JKU Linz, Austria
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

The upstream authors note that some training files may have different or more
restrictive terms. Mazzy does not distribute those training audio files.

## ONNX Runtime Web 1.23.2

- Project: ONNX Runtime
- Source: https://github.com/microsoft/onnxruntime
- Package: `onnxruntime-web@1.23.2`
- Included runtime: JavaScript and `ort-wasm-simd-threaded.asyncify.wasm`
- License: MIT

> Copyright (c) Microsoft Corporation
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.
