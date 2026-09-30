'use strict';
const path = require('node:path');
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const app = createApp({
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB) || 200,
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
});

const server = app.listen(port, () => {
  console.log(`销售资料库已启动：http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    app.locals.close();
    server.close(() => process.exit(0));
  });
}
