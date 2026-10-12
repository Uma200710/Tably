import 'dotenv/config';
import app from './app.js';

const port = Number(process.env.PORT || 4173);
process.env.PUBLIC_URL ||= `http://localhost:${port}`;

app.listen(port, '0.0.0.0', () => {
  console.log(`Tably UI preview at ${process.env.PUBLIC_URL}`);
});