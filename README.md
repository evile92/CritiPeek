# RateFlix

**IMDb & Rotten Tomatoes ratings injected directly into the Netflix web interface.**

Built with Vanilla JavaScript, HTML, and CSS using **Chromium Manifest V3**, compatible with **Opera**, **Opera GX**, **Google Chrome**, **Microsoft Edge**, and **Brave**.

[English Guide](#preview) | [الشرح التفصيلي بالعربية](#النسخة-العربية)

---

## Preview

### Netflix Detail & Preview Modal Badge
Displays IMDb score (with direct clickable link to IMDb) alongside the Rotten Tomatoes Tomatometer score directly inside Netflix's metadata row:

![RateFlix Badge on Netflix Modal](assets/preview-netflix-modal.jpg)

### Extension Settings Popup
Clean dark-mode settings panel to configure and validate your OMDb API key, toggle the extension on/off globally, and inspect or clear the 7-day local cache:

![RateFlix Settings Popup](assets/preview-popup-settings.png)

---

## Features

- **IMDb & Rotten Tomatoes Scores**: Fetches `imdbRating`, `imdbID` (clickable IMDb page link), and the Rotten Tomatoes score from `Ratings`.
- **Hover & Modal Support**:
  - Floating badge (`top: 8px; left: 8px`) on Netflix thumbnail cards.
  - Inline pill badge inside Netflix mini-modals and expanded detail modals.
- **API Rate-Limit Protection**:
  - Does **not** fetch ratings for all visible thumbnails on page load.
  - Thumbnail requests fire only after hovering (`mouseenter`) for **250ms** (canceled automatically if `mouseleave` occurs earlier).
  - Cached titles render immediately with zero extra API calls.
- **Smart Title Cleaning & Fallback**:
  - Strips Netflix noise prefixes/suffixes (e.g., `Watch `, `(Limited Series)`, `- Season X`, trailing colons) before querying OMDb.
  - Queries with `title + year` when a 4-digit release year is available, and automatically falls back to `title`-only if the year lookup fails or returns `Response: "False"`.
- **Two-Layer 7-Day Cache**:
  - In-memory `Map` + persistent `chrome.storage.local` cache keyed by normalized title with a 7-day TTL, plus in-flight request deduplication.
- **Opera GX "Force Dark Pages" Protection**:
  - Uses `color-scheme: dark only;`, `-webkit-print-color-adjust: exact;`, and `forced-color-adjust: none;` so browser dark-mode overrides do not invert badge colors.
- **Safe Playback Interaction**:
  - Clicking the IMDb badge opens the title's IMDb page in a new tab with `e.stopPropagation()` so it never triggers Netflix video playback.

---

## How It Works (Architecture)

1. **`manifest.json`**
   Declares a minimal Manifest V3 configuration requiring only `storage` permission and host access for `https://*.netflix.com/*` and `https://www.omdbapi.com/*`, avoiding Chrome-proprietary manifest keys that cause warnings in `opera://extensions`.

2. **`content.js` (DOM Observer & Badge Injection)**
   - Uses stable attributes and structural selectors (`.slider-item`, `.title-card-container`, `[data-uia="title-card"]`, `a[aria-label]`, `.previewModal--wrapper`, `[data-uia="mini-modal"]`, `.previewModal--detailsMetadata`, `[data-uia="video-metadata"]`) rather than obfuscated Netflix CSS hashes.
   - Attaches `mouseenter` / `mouseleave` listeners with a 250ms debounce timer on thumbnail cards.
   - Runs a `MutationObserver` on `document.body` (`childList: true, subtree: true`) to detect opened mini-modals and detail modals, extract the cleaned title and release year, and inject the rating badge immediately.
   - Marks processed containers with `data-ratings-injected="true"` and tracks the active title (`data-ratings-title`) so SPA navigation between titles cleanly updates without duplicate badges.

3. **`background.js` (Service Worker & OMDb Integration)**
   - Listens for `GET_RATINGS`, `VALIDATE_API_KEY`, `GET_CACHE_STATS`, and `CLEAR_CACHE` messages via `chrome.runtime.onMessage` (returning `true` for async responses).
   - Resolves cached entries from `memoryCache` first, then `chrome.storage.local` (pruning entries older than 7 days), and deduplicates simultaneous requests for the same title.
   - Queries `https://www.omdbapi.com/?t={title}&y={year}&apikey={apiKey}` with automatic fallback to `https://www.omdbapi.com/?t={title}&apikey={apiKey}`.

4. **`styles.css`**
   - Styles the dark translucent badge (`rgba(15, 23, 42, 0.88)` with `backdrop-filter: blur(6px)`), IMDb gold accent (`#F5C518`), Rotten Tomatoes indicator (`#FA320A` for `>= 60%`, `#22C55E` for `< 60%`), and protects colors from Opera's Force Dark Pages.

5. **`popup.html` & `popup.js`**
   - Stores your OMDb API key and global enable/disable toggle in `chrome.storage.local`.
   - Validates your API key against `https://www.omdbapi.com/?i=tt3896198&apikey={key}`.
   - Displays the live count of cached titles and lets you clear the cache with one click.

---

## Installation & Setup

### Step 1: Download the Repository
Clone or download this repository to your computer:

```bash
git clone https://github.com/evile92/RateFlix.git
```

*(Or click **Code -> Download ZIP** on GitHub and extract the folder.)*

### Step 2: Load the Extension in Your Browser

#### Opera / Opera GX
1. Open `opera://extensions` in the address bar.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the downloaded `RateFlix` folder.
4. Pin the extension from the toolbar **Extensions** menu.

#### Google Chrome / Edge / Brave
1. Open `chrome://extensions` (or `edge://extensions` / `brave://extensions`).
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the downloaded `RateFlix` folder.

### Step 3: Add Your Free OMDb API Key
1. Click the **RateFlix** extension icon in your browser toolbar.
2. Click **Get free key** (or visit [omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx)).
3. Select **FREE! (1,000 daily limit)**, enter your email and a short usage description, then submit.
4. **Open your email and click the activation link** from OMDb so the key becomes active.
5. Paste the API key into the extension popup and click **Save** — you should see a green **Valid API key** indicator.
6. Open or refresh `netflix.com`, hover over any title for 250ms, or click any title to open its modal.

---

## Project Structure

```text
RateFlix/
├── assets/
│   ├── preview-netflix-modal.jpg
│   └── preview-popup-settings.png
├── manifest.json
├── background.js
├── content.js
├── styles.css
├── popup.html
├── popup.js
├── .gitignore
└── README.md
```

---

## Privacy

- Your OMDb API key and cached ratings are stored strictly locally in your browser via `chrome.storage.local`.
- Only cleaned movie/series titles (and optional release year) are sent to `omdbapi.com` when you hover for 250ms or open a title modal.

---

## النسخة العربية

### نبذة عن أداة RateFlix

أداة خفيفة للمتصفح تعرض تقييمات **IMDb** و **Rotten Tomatoes** مباشرة داخل واجهة موقع **Netflix** (على الصور المصغرة وداخل نوافذ التفاصيل)، وتعمل على **Opera** و **Opera GX** و **Google Chrome** و **Edge** و **Brave**.

---

### كيف تعمل الأداة من الداخل؟

1. **التعامل الذكي مع واجهة Netflix (`content.js`)**:
   - تعتمد الأداة على محددات وسمات مستقرة داخل الصفحة بدلاً من أسماء الكلاسات العشوائية التي تتغير باستمرار في React.
   - تقوم دالة `cleanTitle` بتنظيف اسم الفيلم أو المسلسل من الزوائد الشائعة في Netflix (مثل `Watch ` أو `(Limited Series)` أو `- Season X` أو النقطتين في النهاية) قبل البحث عنه.
   - **حماية حدود الطلبات (Rate-Limit Protection)**:
     - عند فتح الصفحة، لا يتم جلب التقييمات لكل الأفلام الظاهرة دفعة واحدة.
     - عند تمرير مؤشر الفأرة على أي صورة مصغرة (`mouseenter`)، تنتظر الأداة **250 مللي ثانية** قبل إرسال الطلب (وإذا أزلت المؤشر قبل ذلك يُلغى الطلب فوراً).
     - عند فتح نافذة التفاصيل أو المعاينة السريعة، يلتقط `MutationObserver` النافذة فور ظهورها ويحقن شارة التقييم مباشرة في سطر المعلومات.
     - عند الضغط على تقييم **IMDb** يُفتح رابط الفيلم في تبويب جديد مع منع تشغيل الفيديو تلقائياً عبر `e.stopPropagation()`.

2. **جلب البيانات والتخزين المؤقت (`background.js`)**:
   - يرسل الطلب إلى **OMDb API** باستخدام العنوان + سنة الإصدار أولاً (إن وُجدت السنة)، وإذا فشل البحث أو أرجع `{ Response: "False" }` ينفّذ تلقائياً بحثاً احتياطياً باستخدام العنوان فقط.
   - يستخرج تقييم IMDb ومعرّفه (`imdbID`) وتقييم Rotten Tomatoes من مصفوفة `Ratings`.
   - يحفظ النتائج في الذاكرة (`Map`) وفي التخزين المحلي للمتصفح `chrome.storage.local` لمدة **7 أيام**؛ لذلك يتم جلب كل فيلم مرة واحدة فقط، وعند تكرار المرور عليه يظهر التقييم فوراً بدون أي طلب إضافي.

3. **التصميم والحماية من الوضع الليلي القسري (`styles.css`)**:
   - تستخدم الشارة خلفية داكنة شبه شفافة مع تأثير ضبابي (`backdrop-filter`) وخصائص `color-scheme: dark only` و `-webkit-print-color-adjust: exact` لمنع ميزة **Force Dark Pages** في Opera GX من عكس أو تشويه الألوان.
   - يظهر تقييم IMDb بلون ذهبي (`#F5C518`)، وتظهر أيقونة Rotten Tomatoes باللون الأحمر (`#FA320A`) عند 60% فأكثر، وباللون الأخضر (`#22C55E`) إذا كانت أقل من 60%.

4. **لوحة الإعدادات (`popup.html` و `popup.js`)**:
   - إدخال مفتاح OMDb API وحفظه محلياً مع فحص تلقائي لصلاحيته.
   - زر لتشغيل أو إيقاف الأداة بالكامل فوراً.
   - عدّاد لعدد العناوين المحفوظة في الكاش مع زر **Clear Cache** لمسحها عند الحاجة.

---

### طريقة التثبيت والتشغيل

#### 1. تحميل الملفات
حمّل المستودع عبر `git clone` أو اضغط **Code -> Download ZIP** في GitHub ثم فك الضغط عن المجلد:

```bash
git clone https://github.com/evile92/RateFlix.git
```

#### 2. تثبيت الإضافة في المتصفح
* **في Opera / Opera GX**:
  1. افتح الرابط `opera://extensions` في شريط العنوان.
  2. فعّل **Developer mode** (وضع المطور) من أعلى اليمين.
  3. اضغط **Load unpacked** واختر مجلد `RateFlix`.
* **في Google Chrome** (أو Edge / Brave):
  1. افتح الرابط `chrome://extensions`.
  2. فعّل **Developer mode** من أعلى اليمين.
  3. اضغط **Load unpacked** واختر مجلد `RateFlix`.

#### 3. إعداد مفتاح OMDb API المجاني
1. افتح أيقونة الإضافة من شريط الأدوات واضغط على **Get free key** (أو ادخل إلى [omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx)).
2. اختر الخطة المجانية **`FREE! (1,000 daily limit)`** وأدخل بريدك الإلكتروني ووصفاً مختصراً للاستخدام ثم اضغط **Submit**.
3. افتح بريدك الإلكتروني و**اضغط على رابط التفعيل** في رسالة OMDb حتى يتفعّل المفتاح.
4. الصق المفتاح في نافذة الإضافة واضغط **Save** لتظهر لك حالة **Valid API key** باللون الأخضر.
5. افتح موقع `netflix.com` أو أعد تحميله، وستظهر التقييمات عند تمرير المؤشر لمدة 250ms أو عند فتح نافذة أي فيلم أو مسلسل.
