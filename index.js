import 'react-native-url-polyfill/auto'; // <-- Must be line 1
import 'text-encoding-polyfill'; // <-- Polyfills global TextEncoder and TextDecoder
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
