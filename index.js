import 'react-native-url-polyfill/auto'; // <-- Must be line 1
import 'fast-text-encoding';
import { TextEncoder, TextDecoder } from 'fast-text-encoding';

// Explicitly bind to every global scope Hermes/JSC checks
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

if (typeof globalThis !== 'undefined') {
  // eslint-disable-next-line no-undef
  globalThis.TextEncoder = TextEncoder;
  // eslint-disable-next-line no-undef
  globalThis.TextDecoder = TextDecoder;
}

if (typeof window !== 'undefined') {
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
}

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
