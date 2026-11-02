// Vercel serverless entry: runs the same One Seat handler as server.js.
import { handler } from '../server.js';
export default function oneSeat(req, res) {
  return handler(req, res).catch(() => { res.statusCode = 500; res.end('Something went wrong'); });
}
