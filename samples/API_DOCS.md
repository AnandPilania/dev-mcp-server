# User API Documentation

## Overview
The User API manages user accounts, authentication, and status transitions.
All endpoints require a valid JWT in the `Authorization: Bearer <token>` header.

## Endpoints

### GET /users/:id
Returns a UserDTO object. Cached for 300 seconds.

**Common errors:**
- `404 Not Found` — user does not exist
- `ClassCastException` — occurs when the DB returns a raw Mongoose document instead of a plain object; call `.toObject()` before passing to `UserDTO`

### POST /users
Creates a new user. Triggers a welcome email (non-blocking).

**Body:**
```json
{ "email": "user@example.com", "name": "Jane Doe", "role": "viewer" }
```

**Notes:**
- Email must be unique. Returns 409 if already registered.
- Status defaults to `pending`. Use `PATCH /users/:id/status` to activate.

### PATCH /users/:id/status
Updates a user's status. Valid values: `active`, `inactive`, `banned`, `pending`.

**Side effects:**
- Invalidates the user cache entry (`user:<id>`)
- Emits `user.status.changed` event consumed by: NotificationService, AuditService, BillingService

**Breaking change risk:** HIGH — any service listening to `user.status.changed` is affected.

## Data Models

### User (DB)
```
id, email, name, role, status, createdAt, updatedAt, deletedAt
```

### UserDTO (API response)
```
id, email, name, role, status, createdAt
```
**Important:** UserDTO strips `deletedAt` and other internal fields. Always use UserDTO in API responses, never the raw User model.

## Known Issues & Edge Cases
- `getUserById` has a known bug where it passes a Mongoose Document directly to `UserDTO`. This causes a `ClassCastException`. Always call `.toObject()` first.
- Redis cache may timeout under high load. The service falls back to the DB automatically.
- The `_emit` method uses `process.emit` as a temporary event bus. This does NOT work in clustered environments. Tracked in JIRA-441.
