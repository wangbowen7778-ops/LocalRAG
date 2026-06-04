import { initStorage, listProviders, upsertProvider } from './dist/main/storage.js';
import { app } from 'electron';

const fakeApp = {
  getPath: (name) => 'D:/code/LocalRAG/_test_userdata',
  getName: () => 'LocalRAG-Test',
  getVersion: () => '1.0.0',
};

import { default as origApp } from 'electron';
Object.defineProperty(import.meta, 'electron', { value: fakeApp }); // doesn't work
console.log('Will try to use the real electron');
