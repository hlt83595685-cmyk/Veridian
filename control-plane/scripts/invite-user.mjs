#!/usr/bin/env node
// Admin-only account creation, for the hardened deployment mode
// (GOTRUE_DISABLE_SIGNUP=true -- see docker-compose.yml). Calls GoTrue's
// admin API directly with the service_role key, which only the admin ever
// holds -- never shipped in the Veridian client. Not needed in the default
// configuration, where anyone can sign up normally from the app (harmless:
// an account with no workspace invites can see and do nothing).
//
// Usage:
//   node invite-user.mjs <control-plane-url> <service-role-key> <email>
//
// Prints a temporary password -- relay it to the person out-of-band (they
// aren't given a way to set their own password in v1; that's a follow-up).
import { randomBytes } from 'crypto'

const [, , baseUrl, serviceRoleKey, email] = process.argv
if (!baseUrl || !serviceRoleKey || !email) {
  console.error('Usage: node invite-user.mjs <control-plane-url> <service-role-key> <email>')
  process.exit(1)
}

const tempPassword = randomBytes(9).toString('base64url')

const res = await fetch(`${baseUrl.replace(/\/$/, '')}/auth/v1/admin/users`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${serviceRoleKey}`,
    'apikey': serviceRoleKey,
  },
  body: JSON.stringify({ email, password: tempPassword, email_confirm: true }),
})

if (!res.ok) {
  console.error(`Failed (HTTP ${res.status}):`, await res.text())
  process.exit(1)
}

const user = await res.json()
console.log(`Account created: ${user.email} (id: ${user.id})`)
console.log(`Temporary password: ${tempPassword}`)
console.log('\nRelay both to the person out-of-band. They can sign in from')
console.log('Settings -> Workspace in Veridian with these credentials.')
