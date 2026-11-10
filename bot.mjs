import { startApp } from './src/app.mjs';
import { log } from './src/core.mjs';

startApp().catch((error) => {
  log('app', '启动失败', error.stack || error.message);
  process.exit(1);
});
