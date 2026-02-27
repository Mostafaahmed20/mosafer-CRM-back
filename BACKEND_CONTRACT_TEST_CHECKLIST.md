# Backend Contract Test Checklist

Use this before pushing to GitHub to validate backend contract compatibility with your frontend analytics/admin scope.

## 0) Prerequisites

- Start backend:
```powershell
pnpm --filter @trello/server dev
```
- Set test variables in a second PowerShell terminal:
```powershell
$BASE = "http://localhost:5000"
$EMAIL = "admin@example.com"
$PASSWORD = "123456"
```
- You need a **verified admin** user to test admin/analytics routes.

## 1) Login payload contract (`/api/users/login`)

```powershell
$login = Invoke-RestMethod -Method Post -Uri "$BASE/api/users/login" -ContentType "application/json" -Body (@{
  email = $EMAIL
  password = $PASSWORD
} | ConvertTo-Json)

$TOKEN = $login.token
$USER = $login.user
$USER | ConvertTo-Json -Depth 5
```

Expected `user` fields:
- `_id`
- `username`
- `email`
- `role` (`admin` or `user`)
- `canViewAllAnalytics` (`true`/`false`)

## 2) Admin users list (`GET /api/users/admin/users`)

```powershell
$adminUsers = Invoke-RestMethod -Method Get -Uri "$BASE/api/users/admin/users" -Headers @{ Authorization = "Bearer $TOKEN" }
$adminUsers | ConvertTo-Json -Depth 8
```

Expected:
- top-level `users` array
- each user includes `_id, username, email, role, canViewAllAnalytics`
- optional `emailVerified, createdAt, updatedAt`

## 3) Change role (`PATCH /api/users/admin/:userId/role`)

Pick a non-critical user id first:
```powershell
$TARGET_USER_ID = "<put-user-id-here>"
```

Promote:
```powershell
Invoke-RestMethod -Method Patch -Uri "$BASE/api/users/admin/$TARGET_USER_ID/role" `
  -Headers @{ Authorization = "Bearer $TOKEN" } `
  -ContentType "application/json" `
  -Body (@{ role = "admin" } | ConvertTo-Json) | ConvertTo-Json -Depth 8
```

Demote:
```powershell
Invoke-RestMethod -Method Patch -Uri "$BASE/api/users/admin/$TARGET_USER_ID/role" `
  -Headers @{ Authorization = "Bearer $TOKEN" } `
  -ContentType "application/json" `
  -Body (@{ role = "user" } | ConvertTo-Json) | ConvertTo-Json -Depth 8
```

Expected:
- response has `user.role`
- if demoted to `user`, `user.canViewAllAnalytics` becomes `false`

## 4) Toggle analytics access (`PATCH /api/users/admin/:userId/analytics-access`)

```powershell
Invoke-RestMethod -Method Patch -Uri "$BASE/api/users/admin/$TARGET_USER_ID/analytics-access" `
  -Headers @{ Authorization = "Bearer $TOKEN" } `
  -ContentType "application/json" `
  -Body (@{ canViewAllAnalytics = $true } | ConvertTo-Json) | ConvertTo-Json -Depth 8
```

Expected:
- response `user` includes `_id, username, email, role, canViewAllAnalytics`
- enabling analytics for non-admin should return `400` with `{ "message": "..." }`

## 5) Analytics dashboard (`GET /api/analytics/dashboard`)

Valid ranges:
```powershell
Invoke-RestMethod -Method Get -Uri "$BASE/api/analytics/dashboard?range=24h" -Headers @{ Authorization = "Bearer $TOKEN" } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Get -Uri "$BASE/api/analytics/dashboard?range=7d"  -Headers @{ Authorization = "Bearer $TOKEN" } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Get -Uri "$BASE/api/analytics/dashboard?range=30d" -Headers @{ Authorization = "Bearer $TOKEN" } | ConvertTo-Json -Depth 10
```

Expected shape:
- `range`, `generatedAt`
- `trend[]` with `label, opened, resolved, sla`
- `teams[]` with `team, closed, breached`
- `reports.operations[]`, `reports.service[]`, `reports.efficiency[]`
- every report item has `status` in: `good | watch | risk`
- `summary` has `opened, resolved, sla, backlog, firstResponse`

Invalid range test:
```powershell
try {
  Invoke-RestMethod -Method Get -Uri "$BASE/api/analytics/dashboard?range=90d" -Headers @{ Authorization = "Bearer $TOKEN" }
} catch {
  $_.Exception.Response.StatusCode.value__
  (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd()
}
```

Expected:
- `400` and JSON `{ "message": "..." }`

## 6) Admin tickets list (`GET /api/admin/tickets`)

Default:
```powershell
Invoke-RestMethod -Method Get -Uri "$BASE/api/admin/tickets" -Headers @{ Authorization = "Bearer $TOKEN" } | ConvertTo-Json -Depth 10
```

With full query sample:
```powershell
$url = "$BASE/api/admin/tickets?page=1&limit=25&q=&status=&priority=&group=&boardId=&listId=&agentId=&includeArchived=false&includeClosed=true&sortBy=updatedAt&sortDir=desc"
Invoke-RestMethod -Method Get -Uri $url -Headers @{ Authorization = "Bearer $TOKEN" } | ConvertTo-Json -Depth 10
```

Expected:
- `scope = "global-admin"`
- `items[]` each has:
  - `card` with `_id,title,subject,description,status,priority,group,agent,bookingRef,requester,createdAt,updatedAt`
  - `board` with `_id,title`
  - `listMeta` with `_id,title,board,archived,position`
- `pagination` with `page,limit,total,totalPages,hasNext`
- `filters` object

Invalid sort test:
```powershell
try {
  Invoke-RestMethod -Method Get -Uri "$BASE/api/admin/tickets?sortBy=dueDate&sortDir=desc" -Headers @{ Authorization = "Bearer $TOKEN" }
} catch {
  $_.Exception.Response.StatusCode.value__
  (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd()
}
```

Expected:
- `400` and JSON `{ "message": "..." }`

## 7) Admin ticket detail (`GET /api/admin/tickets/:cardId`)

Get first card id from list:
```powershell
$tickets = Invoke-RestMethod -Method Get -Uri "$BASE/api/admin/tickets?page=1&limit=1" -Headers @{ Authorization = "Bearer $TOKEN" }
$CARD_ID = $tickets.items[0].card._id
$CARD_ID
```

Get detail:
```powershell
Invoke-RestMethod -Method Get -Uri "$BASE/api/admin/tickets/$CARD_ID" -Headers @{ Authorization = "Bearer $TOKEN" } | ConvertTo-Json -Depth 10
```

Expected:
- `card` (same core fields as list card object)
- `list` with `_id,title,board`
- `board` with `_id,title`

## 8) Error contract smoke tests

- No token:
```powershell
try { Invoke-RestMethod -Method Get -Uri "$BASE/api/users/admin/users" } catch { $_.Exception.Response.StatusCode.value__ }
```
Expected `401`.

- Non-admin token on admin route:
Expected `403` with `{ "message": "..." }`.

- Not found id:
```powershell
try {
  Invoke-RestMethod -Method Get -Uri "$BASE/api/admin/tickets/000000000000000000000000" -Headers @{ Authorization = "Bearer $TOKEN" }
} catch {
  $_.Exception.Response.StatusCode.value__
  (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd()
}
```
Expected `404` with `{ "message": "..." }`.

## 9) Optional: Google login payload contract (`/api/users/google`)

If your Google auth is configured and frontend gets an ID token, verify:
- response includes `token`
- `user` includes `_id, username, email, role, canViewAllAnalytics`
