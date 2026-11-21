import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './dist/db/schema/index.js',
  out: './drizzle',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://kestrel:kestrel_dev_password@localhost:5432/kestrel_it',
  },
});
