# نقل «مساعد صفوان الذكي» من Vercel إلى Railway

**الحالة:** تجهيز فقط — لم يُنفَّذ أي نشر. Vercel يعمل دون تغيير. آخر تحديث: 2026-11-01.

## القرارات المعتمدة
- Railway هي منصة الاستضافة الأساسية الجديدة؛ مشروع `natural-miracle`، بيئة `production`، بلا Staging.
- يبقى Vercel مؤقتًا إلى أن يثبت نجاح النقل.
- مشروع «أَوْج AWJ» على Railway مستقل تمامًا ولا يُمَسّ.

## الوضع الحالي (مُتحقَّق منه)
| البند | الحالة |
|---|---|
| مشروع Railway | `natural-miracle` (`f66bca9a…`)، بيئة `production`، خدمة وحيدة `@safwan/web` |
| الخدمة | **لم تُنشأ فعليًا**: `staged-create`، لا نشر ولا نطاق |
| المصدر | `safwan5001-source/safwan-smart-assistant` فرع `main` |
| بناء الواجهة | `pnpm install --frozen-lockfile` ✓ · typecheck ✓ · lint ✓ · vitest ✓ · `next build` ✓ (12 صفحة ثابتة) |
| تشغيل الواجهة | `PORT=4567 pnpm --filter @safwan/web start` → `/` و`/chat` = 200، ترويسات الأمان حاضرة |
| API | pytest: 47 ناجح (على `main`) |

## التغييرات المعلّقة على Railway (16 تغييرًا — لم تُطبَّق)
الأصلية السبعة (repo/branch/builder RAILPACK/build/start/watch) أُبقيت كما هي، وأضيف:

| الإعداد | القيمة | السبب |
|---|---|---|
| Watch Patterns | `/apps/web/**`, `/package.json`, `/pnpm-lock.yaml`, `/pnpm-workspace.yaml` | النمط الأصلي كان يتجاهل تغييرات الاعتماديات الجذرية |
| Healthcheck | `/` · مهلة 120ث | `/api/health` غير موجود في `main` (يأتي مع PR #26) |
| Restart policy | `ON_FAILURE` × 5 | |
| المتغيرات | `APP_ENV=production`, `ENABLE_DEV_AUTH=false`, `ASSISTANT_PROVIDER=none`, `NEXT_TELEMETRY_DISABLED=1` | إغلاق وضع التطوير (fail-closed) |
| ⚠️ `NODE_ENV=production` | **يجب حذفه قبل النشر** | تعيينه وقت التثبيت قد يجعل pnpm يتخطى devDependencies (typescript/types) فيفشل البناء؛ Railpack/Next يضبطانه تلقائيًا |

**جذر الخدمة:** يبقى جذر المستودع (لا Root Directory) لأن `pnpm --filter` يحتاج مساحة العمل كاملة.

## متغيرات البيئة
**الواجهة (`@safwan/web`)** — الآن: المذكورة أعلاه فقط. لا شيء بادئته `NEXT_PUBLIC_` يحمل سرًا.
اختياري لاحقًا (بعد وجود API): `API_PROXY_URL=http://<api-private-name>.railway.internal:<port>` — يجب أن يكون موجودًا **وقت البناء** لأن `rewrites()` تُقيَّم عند البناء.

**API (المرحلة 2):** `APP_ENV=production`، `ASSISTANT_PROVIDER=none`، وبعد PR #26: `APP_DATABASE_URL` (دور تشغيل مقيَّد وليس المالك)، `SERVICE_AUTH_SECRET` (نفس القيمة في الخدمتين، Sealed). لا تضبط `DATABASE_URL` بدور المالك.

**Browserbase (المرحلة 4+):** `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` — على خدمة Worker فقط، Sealed، لا تصل الواجهة ولا المتصفح أبدًا.

## خطة التشغيل التدريجية
| المرحلة | المحتوى | بوابة الانتقال |
|---|---|---|
| **1 — الواجهة** | نشر `@safwan/web` على نطاق `*.up.railway.app` | 200 على الصفحات، ترحيل بيانات المتصفح سليم، لا أخطاء في السجل |
| **2 — API** | خدمة `api`: Root `services/api`، Start `uvicorn app.main:app --host 0.0.0.0 --port $PORT`، **بلا نطاق عام** (شبكة خاصة فقط)، Healthcheck `/health` | `/health` عبر الشبكة الخاصة، المسارات المحمية ترفض بلا توقيع |
| **3 — PostgreSQL** | قالب Postgres من Railway في المشروع نفسه؛ ترحيلات PR #26 بدور المالك؛ إنشاء دور تشغيل `NOSUPERUSER NOBYPASSRLS` | اختبارات RLS تنجح على القاعدة الفعلية |
| **4 — Worker** | خدمة منفصلة لمهام الخلفية (لا عملية داخل API) ومتصلة بـ Browserbase | بعد نجاح Smoke-1 (`poc/smoke1`) |
| **5 — القطع** | نقل النطاق إلى Railway، إبقاء Vercel احتياطيًا أسبوعًا، ثم إيقافه | موافقة صريحة |

## التكامل مع Browserbase
لا تغيير معماري: الجلسات تُدار من Worker خاص على Railway؛ المفاتيح Sealed؛ الحزمة `poc/smoke1` تبقى معزولة داخل `poc/`. Railway لا يقيّد الاتصال الصادر إلى Browserbase.

## عدم التأثير على Vercel وأَوْج
- لم يُعدَّل `vercel.json` ولا أي مشروع Vercel. وصول Vercel عبر الأداة مرفوض حاليًا (403) فلم يُفحص من جهتها شيء.
- الخدمة على Railway تتبع `main` فقط، ولا تُنشئ أي webhook على Vercel.
- مشروع «أَوْج AWJ» (`18791e5b…`) لم يُلمس.

## PR #26 — شروط الدمج (لا يُدمج الآن)
- يغيّر `vercel.json` (Service Binding خاص) → يؤثر على Vercel الحالي، وشرطه المعلن اجتياز `docs/B1-PREVIEW-CHECKLIST.md` على Vercel Preview ولم يحدث.
- فرعه مبني على `main` قديم (`032b3bc`) بينما `main` الآن `93c5f85` → يحتاج تحديثًا قبل أي دمج.
- الدمج سيطلق إعادة نشر `@safwan/web` على Railway تلقائيًا (Watch Patterns تطابق ملفاته).
- Service Binding خاص بـ Vercel؛ على Railway يُستبدل بشبكة خاصة + `BACKEND_URL`/`API_PROXY_URL` — قرار يُتخذ بعد المرحلة 2.

## خطوات أول نشر (تنتظر موافقتك)
1. في Railway ← natural-miracle ← Staged Changes: **احذف متغير `NODE_ENV`**.
2. راجع التغييرات (16 → 15) ثم **Deploy**.
3. بعد نجاح البناء: توليد نطاق `*.up.railway.app` والتحقق من الصفحات.

## الرجوع
حذف الخدمة أو تعطيل النطاق في Railway لا يؤثر على Vercel. لا نقل DNS قبل المرحلة 5.
