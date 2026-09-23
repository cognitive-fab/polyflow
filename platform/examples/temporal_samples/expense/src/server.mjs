// The sample's expense HTTP server (upstream src/server/index.ts), in
// JavaScript: the same endpoints, the same status transitions. It is the
// system of record the two activities POST to; nothing in it knows about
// Polyflow. `startServer(port)` is exported for the test.
import express from 'express';
import http from 'node:http';

export const ExpenseStatus = {
  CREATED: 'CREATED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  TIMED_OUT: 'TIMED_OUT',
  COMPLETED: 'COMPLETED',
};

function actionStringToExpenseStatus(action) {
  switch (action) {
    case 'payment':
      return ExpenseStatus.COMPLETED;
    default:
      throw new Error(`Invalid action ${action}`);
  }
}

function isValidTransition(oldStatus, newStatus) {
  switch (oldStatus) {
    case ExpenseStatus.CREATED:
      return newStatus === ExpenseStatus.COMPLETED;
    default:
      return false;
  }
}

export async function startServer(port = 3000) {
  const app = express();
  app.use(express.json());

  const allExpenses = new Map();

  app.get('/', (_req, res) => res.json(Object.fromEntries(allExpenses)));
  app.get('/list', (_req, res) => res.json(Object.fromEntries(allExpenses)));

  app.post('/create', (req, res) => {
    const { id } = req.body;
    allExpenses.set(id, ExpenseStatus.CREATED);
    return res.json({ ok: true });
  });

  app.post('/action', (req, res) => {
    const { id, action } = req.body;
    if (typeof id !== 'string' || typeof action !== 'string') {
      return res.status(400).json({ error: 'Invalid request body, expected JSON with id and action attributes' });
    }
    const oldStatus = allExpenses.get(id);
    if (oldStatus === undefined) {
      return res.status(404).json({ error: `No expense found for id: ${id}` });
    }
    const newStatus = actionStringToExpenseStatus(action);
    if (!isValidTransition(oldStatus, newStatus)) {
      return res.status(400).json({ error: `Invalid status transition ${oldStatus} -> ${newStatus}` });
    }
    allExpenses.set(id, newStatus);
    return res.json({ ok: true, newStatus });
  });

  app.get('/status', (req, res) => {
    const { id } = req.query;
    if (typeof id !== 'string') {
      return res.status(400).json({ error: 'Invalid or missing "id" query param' });
    }
    const status = allExpenses.get(id);
    if (status === undefined) {
      return res.status(404).json({ error: `No expense found for id: ${id}` });
    }
    return res.json({ status });
  });

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.listen(port, resolve);
    server.once('error', reject);
  });
  return { expenses: allExpenses, close: () => new Promise((resolve) => server.close(resolve)) };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  startServer().then(() => console.log('Listening on port 3000'), (err) => { console.error(err); process.exit(1); });
}
