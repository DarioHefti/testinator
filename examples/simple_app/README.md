# Simple TODO App

A minimal TODO application for testing the Testinator framework.

## Features

- Simple login with JWT authentication
- In-memory storage (resets on server restart)
- Basic CRUD operations for todos

## Test Users

| Username | Password   |
|----------|------------|
| admin    | admin123   |
| user     | user123    |

## Running

```bash
cd examples/simple_app
npm install
npm start
```

The app will be available at http://localhost:3000

## API Endpoints

### Authentication

**POST /api/login**
```json
{ "username": "admin", "password": "admin123" }
```
Returns: `{ "token": "jwt...", "user": { "id": 1, "username": "admin" } }`

### Todos (require `Authorization: Bearer <token>` header)

| Method | Endpoint        | Body                                  | Description        |
|--------|-----------------|---------------------------------------|--------------------|
| GET    | /api/todos      | -                                     | Get all user todos |
| POST   | /api/todos      | `{ "title": "My todo" }`              | Create todo        |
| PUT    | /api/todos/:id  | `{ "title": "...", "completed": true }`| Update todo        |
| DELETE | /api/todos/:id  | -                                     | Delete todo        |
