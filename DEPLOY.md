# TMS Performance deployment

## Recommended: Render Web Service

This project is a Node.js server application with SQLite and file uploads. Deploy it as a **Web Service**, not a static site.

### Why a persistent disk is required
The app stores its SQLite database, uploaded files, logs, and backups under `data/`. Render's normal filesystem is ephemeral, so the service needs a persistent disk mounted at `/opt/render/project/src/data`.

### Deploy from GitHub
1. Create a GitHub repository and upload this project.
2. In Render, choose **New → Blueprint** and select the repository. Render will read `render.yaml`.
3. Keep the web service as a single instance.
4. When prompted, enter values for `ADMIN_USER` and `ADMIN_PASSWORD` (at least 10 characters for the password).
5. Deploy.
6. Open the generated `https://<service-name>.onrender.com/` URL.
7. Admin is at `/admin`.

The included `render.yaml` sets Node 22.16, production mode, the health check, a persistent disk, and a generated `SESSION_SECRET`.

### Important
- The persistent disk is needed because this app uses SQLite and local uploads.
- The project currently has no imported vehicle database. The VIN lookup can use NHTSA, but the manual Make → Model → Generation → Engine configurator will remain empty until vehicle data is imported through the admin tools.
- Do not commit `.env`, `data/`, or real admin credentials.

## Local verification

```bash
npm test
npm start
```

Then open `http://localhost:10000/`.
