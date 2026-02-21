# Choir SaaS - Code Review Report
**Date:** 2026-02-10  
**Reviewer:** Clawd (with sub-agent research)  
**Status:** Pre-deployment review

---

## 1. Architecture Overview

**Stack:**
| Layer | Technology | Status |
|-------|------------|--------|
| **Frontend** | React 19 + Vite + TailwindCSS 4 | ✅ Modern, well-structured |
| **Backend** | Node.js + Express + tRPC | ✅ Type-safe API |
| **OMR Service** | Python + FastAPI + Gemini Vision | ✅ Innovative approach |
| **Database** | MySQL + Drizzle ORM | ✅ Clean schema |
| **Storage** | S3-compatible (AWS/Backblaze/DO) | ✅ Flexible |
| **Auth** | JWT + OAuth (Manus system) | ⚠️ External dependency |
| **Process Mgmt** | PM2 | ✅ Production-ready |

---

## 2. Frontend Review

**Strengths:**
- Clean React 19 + TypeScript setup
- Vite for fast dev builds
- TailwindCSS 4 with shadcn/ui components
- Proper error boundaries
- Theme context for dark/light mode

**Routes:**
- `/` - Home (sheet music list)
- `/upload` - Upload PDF/MusicXML
- `/sheet/:id` - Player with voice isolation

**Issues Found:**
1. **Hardcoded API URLs in .env.production** — Points to `vida.butterfly-effect.dev` domain
2. **ComponentShowcase.tsx** — 55KB file in production (should be dev-only)
3. **No loading states** for async operations visible in review

**Recommendations:**
- [ ] Remove ComponentShowcase from production build
- [ ] Add skeleton loaders for upload/processing states
- [ ] Add retry logic for failed uploads

---

## 3. Backend Review

**Strengths:**
- tRPC for type-safe APIs
- Clean router structure (`routers.ts`)
- Async processing with status tracking
- S3 presigned URLs for secure file access
- Proper auth middleware (protectedProcedure)

**API Endpoints:**
| Endpoint | Description | Status |
|----------|-------------|--------|
| `sheetMusic.upload` | Upload PDF/MusicXML | ✅ Async processing |
| `sheetMusic.get` | Get sheet by ID | ✅ Ownership check |
| `sheetMusic.list` | List user's sheets | ✅ |
| `sheetMusic.updateVoiceAssignments` | Edit voice mapping | ✅ Regenerates MIDI |
| `sheetMusic.getMidiUrl` | Get presigned MIDI URL | ✅ 5min expiry |
| `sheetMusic.delete` | Delete sheet | ✅ S3 cleanup implemented |

**Issues Found:**
1. ~~TODO: S3 cleanup on delete — `deleteSheetMusic` doesn't delete S3 files (orphaned storage)~~ **FIXED**
2. ~~No rate limiting on upload endpoints~~ **FIXED**
3. **No file size limits** enforced server-side
4. **Python service error handling** — Generic error messages exposed to client

**Recommendations:**
- [x] Implement S3 file deletion on sheet delete
- [x] Add upload rate limiting (e.g., 10/hour per user)
- [ ] Add server-side file size validation (e.g., max 10MB)
- [ ] Sanitize Python service errors before sending to client

---

## 4. Python OMR Service Review

**Strengths:**
- FastAPI for async Python service
- Gemini 1.5 Pro for OMR (cutting-edge)
- Music21 for MusicXML parsing
- PDF2Image for PDF processing
- Smart voice detection (name + pitch range + clef)

**Flow:**
1. PDF → Image → Gemini Vision → MusicXML
2. MusicXML → Music21 → Analysis (parts, clefs, pitch ranges)
3. Voice detection → Assignment → MIDI generation
4. MIDI files per voice (S/A/T/B + full)

**Issues Found:**
1. **Gemini API key warning on startup** — Service starts without key check
2. **No fallback OMR** — If Gemini fails, no alternative
3. **Single-page PDF only** — `first_page=1, last_page=1`
4. **No queue system** — Multiple concurrent OMR requests could overwhelm
5. **Missing dependency** — `poppler-utils` required for pdf2image (not in requirements.txt)

**Recommendations:**
- [ ] Add health check endpoint for Gemini API
- [ ] Implement processing queue (Redis/RabbitMQ) for scale
- [ ] Support multi-page PDFs (loop through pages)
- [ ] Document poppler-utils requirement in setup
- [ ] Add retry logic for Gemini API failures

---

## 5. Database Schema Review

**Tables:**

```sql
users (id, name, email, loginMethod, role, stripeCustomerId, createdAt, lastSignedIn)
subscriptions (id, userId, stripeSubscriptionId, status, period dates, etc.)
sheet_music (id, userId, title, filename, fileType, keys, status, analysisResult, voiceAssignments, midiFileKeys, timestamps)
```

**Strengths:**
- Clean Drizzle ORM schema
- Proper foreign keys with cascade delete
- JSON columns for flexible data (analysis, assignments, MIDI keys)
- Timestamps with auto-update

**Issues Found:**
1. **No indexes** on frequently queried columns (`userId`, `status`)
2. **No soft delete** — Hard deletes only
3. **Stripe integration** — Tables present but no Stripe webhook handlers reviewed

**Recommendations:**
- [ ] Add indexes: `sheet_music(userId)`, `sheet_music(status)`
- [ ] Consider soft delete for user data retention
- [ ] Verify Stripe webhook implementation (not reviewed)

---

## 6. Configuration & Deployment

**Environment Variables:**
| Variable | Required | Status |
|----------|----------|--------|
| `DATABASE_URL` | ✅ | Present |
| `JWT_SECRET` | ✅ | Present |
| `GEMINI_API_KEY` | ✅ | Present |
| `AWS_*` (S3) | ✅ | Present |
| `OAUTH_SERVER_URL` | ⚠️ | External dependency |
| `VITE_*` | ✅ | Frontend config |

**Deployment Setup:**
- ✅ PM2 ecosystem config with both Node + Python services
- ✅ Nginx configuration scripts
- ✅ SSL/certbot documentation
- ✅ Database migration scripts

**Issues Found:**
1. **OAuth dependency** — App requires external OAuth server (Manus/Better Auth?)
2. **Hardcoded domains** in `.env.production`
3. **No Docker** — Manual deployment only
4. **No CI/CD** — Manual git pull + restart

**Recommendations:**
- [ ] Document OAuth server setup or provide local auth fallback
- [ ] Create environment-specific configs (dev/staging/prod)
- [ ] Add Dockerfile for containerized deployment
- [ ] Set up GitHub Actions for CI/CD

---

## 7. Security Review

**Strengths:**
- JWT with httpOnly cookies
- S3 presigned URLs (time-limited)
- Ownership checks on all sheet operations
- Zod validation on inputs

**Concerns:**
1. ~~No rate limiting — Vulnerable to brute force / DoS~~ **FIXED** (100 req/15min general, 10 uploads/15min)
2. **No file type validation** beyond extension check
3. **No virus scanning** on uploaded PDFs
4. **CORS policy** — Not reviewed (may be wide open)
5. **No request logging** for security audit trail

**Recommendations:**
- [ ] Add rate limiting middleware
- [ ] Validate file magic numbers (not just extensions)
- [ ] Add ClamAV or similar for PDF scanning
- [ ] Review/configure CORS policy
- [ ] Add security audit logging

---

## 8. Critical Blockers for Deployment

### Must Fix Before Launch:
1. **SSH access to VPS** — Currently blocked, need key fix
2. **S3 file cleanup** — Storage costs will grow unbounded
3. **OAuth dependency** — App won't work without auth server
4. **Database migrations** — Need to run `db:push` on deploy

### Should Fix Soon After:
1. ~~Add rate limiting~~ **DONE**
2. Add file size limits
3. ~~Implement S3 cleanup~~ **DONE**
4. Add health checks for Python service
5. Remove ComponentShowcase from prod

---

## 9. Deployment Readiness Score

| Category | Score | Notes |
|----------|-------|-------|
| **Code Quality** | 8/10 | Clean, modern stack |
| **Security** | 6/10 | Missing rate limiting, CORS |
| **Scalability** | 6/10 | No queue, single-instance |
| **Documentation** | 8/10 | Good deployment guide |
| **Production Hardening** | 6/10 | Missing monitoring, logging |
| **Overall** | 7/10 | Good foundation, needs polish |

---

## 10. Recommended Next Steps

1. **Fix SSH access** (you mentioned handling this)
2. **Run security fixes** (rate limiting, CORS)
3. **Test OAuth flow** on production domain
4. **Deploy to staging** first for validation
5. **Add monitoring** (PM2 logs, error tracking)
6. **Implement S3 cleanup** job

---

**Summary:** Choir is a solid MVP with innovative OMR using Gemini. Core functionality works. Main blockers are SSH access, OAuth dependency, and missing cleanup logic. Ready for deployment after these fixes.
