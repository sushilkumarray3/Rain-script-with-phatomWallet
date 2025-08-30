const g = typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : this;

let TextEncoderImpl = g.TextEncoder;
let TextDecoderImpl = g.TextDecoder;

if (!TextEncoderImpl || !TextDecoderImpl) {
  const { TextEncoder, TextDecoder } = require('fast-text-encoding');
  if (!TextEncoderImpl) TextEncoderImpl = TextEncoder;
  if (!TextDecoderImpl) TextDecoderImpl = TextDecoder;
}

module.exports = {
  TextEncoder: TextEncoderImpl,
  TextDecoder: TextDecoderImpl,
};
