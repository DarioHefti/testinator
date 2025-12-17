const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = 3000;
const JWT_SECRET = 'test-secret-key';

// In-memory storage
const users = [
  { id: 1, username: 'admin', password: 'admin123' },
  { id: 2, username: 'dario', password: 'testinatorIsAwesome' }
];

const todos = [];
let todoIdCounter = 1;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  if (req.method !== 'GET' && Object.keys(req.body).length > 0) {
    console.log('  Body:', JSON.stringify(req.body));
  }
  next();
});

// Auth middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Routes

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = users.find(u => u.username === username && u.password === password);

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '1h' });

  res.json({ token, user: { id: user.id, username: user.username } });
});

// Get all todos for current user
app.get('/api/todos', authenticateToken, (req, res) => {
  const userTodos = todos.filter(t => t.userId === req.user.id);
  res.json(userTodos);
});

// Create todo
app.post('/api/todos', authenticateToken, (req, res) => {
  const { title } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const todo = {
    id: todoIdCounter++,
    userId: req.user.id,
    title,
    completed: false,
    createdAt: new Date().toISOString()
  };

  todos.push(todo);
  res.status(201).json(todo);
});

// Update todo
app.put('/api/todos/:id', authenticateToken, (req, res) => {
  const id = parseInt(req.params.id);
  const todo = todos.find(t => t.id === id && t.userId === req.user.id);

  if (!todo) {
    return res.status(404).json({ error: 'Todo not found' });
  }

  if (req.body.title !== undefined) {
    todo.title = req.body.title;
  }
  if (req.body.completed !== undefined) {
    todo.completed = req.body.completed;
  }

  res.json(todo);
});

// Delete todo
app.delete('/api/todos/:id', authenticateToken, (req, res) => {
  const id = parseInt(req.params.id);
  const index = todos.findIndex(t => t.id === id && t.userId === req.user.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Todo not found' });
  }

  todos.splice(index, 1);
  res.status(204).send();
});

// Serve the frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`TODO app running at http://localhost:${PORT}`);
  console.log('Test users: admin/admin123, dario/testinatorIsAwesome');
});
