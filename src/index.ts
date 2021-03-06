import process from 'process';
import { createConnection } from 'typeorm';
import express from 'express';
import pluralize from 'pluralize';

import createAppRoutes from './routes';
import createEventHandlers from './event-adapter';
import createInteractionHandlers from './interactions-adapter';

const startService = async (): Promise<void> => {
  pluralize.addPluralRule(/^it$/i, 'them');
  await createConnection();

  const app = express();
  createAppRoutes(app);
  createEventHandlers();
  createInteractionHandlers();

  await new Promise<void>((resolve, reject) => {
    try {
      app.listen(
        parseInt(process.env.SERVER_PORT ?? '3000', 10) ?? 3000,
        process.env.SERVER_HOST ?? 'localhost',
        resolve,
      );
    } catch (err) {
      reject(err);
    }
  });
};

startService().catch((err): void => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
