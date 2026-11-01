# مساعد صفوان الذكي | Safwan Smart Assistant

مساعد شخصي ذكي مستقل، واجهته الأولى الآيفون (PWA عربي RTL) وهدفه تنفيذ أعمال المستخدم على المواقع والبرامج عبر واجهاتها.

> **الحالة (نسخة تجريبية):** الواجهة تعمل بالكامل محلياً على جهاز المستخدم (محادثات/ملاحظات، مهام، ملفات، بحث، إعدادات).
> **غير مفعّل بعد:** المساعد الذكي (لا مزوّد نماذج)، تنفيذ الأوامر على الخادم، التكاملات الخارجية، الحساب والمزامنة، المكالمات، Windows السحابي.
> الواجهة تعرض هذه الحالة صراحةً ولا تدّعي أكثر مما يعمل.

## ما يعمل الآن
| القسم | الحالة |
|---|---|
| المحادثات | حقيقي محلياً: سجل، بحث، أرشفة، مرفقات، إملاء عربي (حسب المتصفح)، أوامر سريعة `/مهمة` — بلا ذكاء اصطناعي |
| المهام | حقيقي محلياً: أولوية، استحقاق، ملاحظات، تصفية وترتيب، تأكيد الحذف الجماعي |
| الملفات | حقيقي محلياً (IndexedDB): معاينة، تنزيل، تصفية بالنوع، تقدير المساحة |
| البحث الشامل | حقيقي: يطبّع العربية (همزات/تاء مربوطة/تشكيل) ويشمل كل الأقسام |
| الصلاحيات | سياسة مطبّقة فعلاً في طبقة الأوامر وفي API (مصفوفة مشتركة ومختبرة) |
| التكاملات | كتالوج وحالات صادقة (كلها «قيد التخطيط») — لا اتصال فعلي |
| API | `/health` عام؛ باقي المسارات مقفلة في الإنتاج (انظر الأمان) |

## التشغيل المحلي
```bash
pnpm install --frozen-lockfile
cd services/api && uv sync --frozen --extra test --no-install-project && cd ../..   # قفل Python: services/api/uv.lock

# واجهة + خلفية بسر خدمة مشترك (محلياً فقط)
export SERVICE_AUTH_SECRET="$(openssl rand -base64 48)"
(cd services/api && APP_ENV=development SERVICE_NONCE_STORE=memory uv run --frozen uvicorn app.main:app --port 8000) &
BACKEND_URL=http://127.0.0.1:8000 pnpm dev:web     # http://localhost:3000  ← /api/health يثبت الاتصال الموقَّع

# اختبارات PostgreSQL الحقيقية تتطلب قاعدة مؤقتة (لا تستخدم قاعدة حقيقية أبداً)
export SAFWAN_TEST_DATABASE_URL=postgresql://postgres:***@localhost:5432/postgres REQUIRE_POSTGRES=1
pnpm check                                          # typecheck + lint + vitest + build + pytest
pnpm e2e:bff                                        # Next BFF → API (وضع إنتاج) → PostgreSQL، بعمليات حقيقية
bash scripts/backup-restore-rehearsal.sh                 # تمرين نسخ/استعادة بين عنقودين PostgreSQL مؤقتين (انظر docs/deploy/RAILWAY-PHASE3-DB-AUTH.md §8)
```
المتغيرات في [`.env.example`](.env.example). **لا تضع أي سر في متغير يبدأ بـ `NEXT_PUBLIC_`.** التطبيق يقرأ `APP_DATABASE_URL` (دور مقيَّد) ويتجاهل `DATABASE_URL` عمداً.

## الوثائق
- [المعمارية](docs/ARCHITECTURE.md) · [خطة التنفيذ والقبول](docs/IMPLEMENTATION.md)
- [الأمان والمخاطر المتبقية](docs/SECURITY.md) · [مراجعة B1 الأمنية](docs/B1-SECURITY-REVIEW.md) · [قائمة إثبات Preview](docs/B1-PREVIEW-CHECKLIST.md) · [سجل القرارات](docs/DECISIONS.md) · [تقرير الدفعة التطويرية](docs/DEVELOPMENT_REPORT.md)
- [النشر على Railway — المرحلة 2: API](docs/deploy/RAILWAY-API-PHASE2.md) · [المرحلة 3: PostgreSQL والمصادقة](docs/deploy/RAILWAY-PHASE3-DB-AUTH.md)

## مبادئ معتمدة
- مستخدم واحد؛ منفصل عن أَوْج. دفترة سيناريو اختبار أول لا نطاق المشروع.
- عند كل مهمة: مراجعة فقط، تنفيذ، أو تنفيذ بموافقة؛ والعمليات الحساسة تتطلب موافقة خاصة دائماً.
- سجل تدقيق، حماية من التكرار، إيقاف فوري، واستئناف آمن (مخطط).
- لا تخزن كلمات مرور أو مفاتيح API أو بيانات عملاء حقيقية داخل المستودع.
