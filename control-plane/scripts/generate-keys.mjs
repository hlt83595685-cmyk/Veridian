#!/usr/bin/env node
// Generates ANON_KEY and SERVICE_ROLE_KEY for .env -- both are just JWTs
// signed with JWT_SECRET carrying a `role` claim that PostgREST/GoTrue read
// to decide which Postgres role to run queries as. Pure Node crypto, no
// dependencies -- run with: node generate-keys.mjs <JWT_SECRET>
import { createHmac } from 'crypto'

const secret = process.argv[2] ?? process.env.JWT_SECRET
if (!secret) {
  console.error('Usage: node generate-keys.mjs <JWT_SECRET>')
  console.error('       (or set JWT_SECRET as an env var)')
  process.exit(1)
}

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function sign(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const encHeader = base64url(JSON.stringify(header))
  const encPayload = base64url(JSON.stringify(payload))
  const signature = createHmac('sha256', secret)
    .update(`${encHeader}.${encPayload}`)
    .digest('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encHeader}.${encPayload}.${signature}`
}

const now = Math.floor(Date.now() / 1000)
const tenYears = 10 * 365 * 24 * 60 * 60

const anonKey = sign({ iss: 'supabase', role: 'anon', iat: now, exp: now + tenYears }, secret)
const serviceRoleKey = sign({ iss: 'supabase', role: 'service_role', iat: now, exp: now + tenYears }, secret)

console.log('ANON_KEY=' + anonKey)
console.log('SERVICE_ROLE_KEY=' + serviceRoleKey)
console.log('\n# Paste both lines into .env. ANON_KEY is safe to put in every')
console.log('# collaborator\'s Veridian client (Settings -> Workspace). Never share')
console.log('# SERVICE_ROLE_KEY -- it bypasses every RLS policy. Keep it only in .env')
console.log('# on the server and in your own local env when running invite-user.mjs.')
