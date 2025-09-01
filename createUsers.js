import pool from './db.js'
import bcrypt from 'bcrypt'

async function createUsers() {
  const users = [
    { username: 'Clélia', password: 'test123', role: 'admin' },
    { username: 'Fabienne', password: 'test123', role: 'prof' },
    { username: 'Ludo', password: 'test123', role: 'prof' },
    { username: 'Christian', password: 'chant123', role: 'prof' },
    { username: 'Geoffrey', password: 'test123', role: 'prof' },
    { username: 'Anais', password: 'test123', role: 'prof' },
    { username: 'Sullivan', password: 'test123', role: 'prof' },
    { username: 'Hugo', password: 'test123', role: 'prof' },
    { username: 'Marie', password: 'test123', role: 'prof' },
  ]

  for (const user of users) {
    const hashed = await bcrypt.hash(user.password, 10)
    await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', [
      user.username,
      hashed,
      user.role,
    ])
    console.log(`Utilisateur ${user.username} créé.`)
  }
  process.exit()
}

createUsers().catch((err) => {
  console.error(err)
  process.exit(1)
})
