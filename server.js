import http from 'node:http';
import { createHandler } from './lib/operator-app.js';
export { createHandler } from './lib/operator-app.js';
export const handler = createHandler();
export const server = http.createServer(handler);
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log(`One Seat listening on port ${port}`));
}
