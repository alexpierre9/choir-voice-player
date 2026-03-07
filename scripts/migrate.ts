import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function runMigrations() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }

  const client = postgres(connectionString, { max: 1 })
  const db = drizzle(client)

  console.log('Running database migrations...')
  await migrate(db, { migrationsFolder: resolve(__dirname, '../drizzle') })
  console.log('Migrations complete.')

  await client.end()
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
