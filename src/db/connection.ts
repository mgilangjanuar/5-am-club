import postgres from 'postgres';
import 'dotenv/config';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}

// postgres.js passes unknown URL query params as PostgreSQL SET commands.
// PostgreSQL has no `schema` GUC — remap it to `search_path` instead.
const url = new URL(process.env.DATABASE_URL);
const schema = url.searchParams.get('schema');
url.searchParams.delete('schema');

const sql = postgres(url.toString(), {
  ...(schema && { connection: { search_path: schema } }),
});

export default sql;

