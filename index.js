/**
 * @format
 */
// index.js (TOP — before ANY other import)
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';

import { Buffer } from 'buffer';
global.Buffer = Buffer;

// Hermes Buffer.subarray fix
Buffer.prototype.subarray = function subarray(begin, end) {
  const out = Uint8Array.prototype.subarray.apply(this, [begin, end]);
  Object.setPrototypeOf(out, Buffer.prototype);
  return out;
};

global.TextEncoder = require('text-encoding').TextEncoder;
global.TextDecoder = require('text-encoding').TextDecoder;
global.process = global.process || require('process');


if (typeof global.structuredClone !== 'function') {
  global.structuredClone = (val) => (
    val === undefined ? val : JSON.parse(JSON.stringify(val))
  );
}

import 'assert';

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
