# denolcr

Deno port of Rclone

## Contributing

### Adds a new backend

- `deno init backend/name`
- Edit "backend/name/main.ts" and "backend/name/main_test.ts" for the new
  backend.
- Implements a `fetch` export function that handles "HEAD", "GET", "PUT" and "DELETE".
- Uses `backend/local/main.ts` as reference.
