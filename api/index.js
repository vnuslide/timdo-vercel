const express = require("express");
const cors = require("cors");
const axios = require("axios");

// === KHỐI CẤU HÌNH (CFG) TỔNG ===
const CFG = {
    APP_ID: process.env.lark_app_id,
    APP_SECRET: process.env.lark_app_secret,
    BASE_TOKEN: process.env.lark_base_token,
    TABLE_ID: process.env.lark_table_id,
    USERS_TABLE_ID: process.env.lark_users_table_id,
    GAS_UPLOAD_URL: process.env.gas_upload_url, // (QUAN TRỌNG) Key Proxy
    OPENROUTER_KEYS: [process.env.openrouter_key1],
    HOST: 'https://open.larksuite.com',
    TZ: 'Asia/Ho_Chi_Minh',
    // (ĐÃ XÓA) Google Drive
};

// --- (Các hàm helper) ---
let larkTokenCache = { token: null, exp: 0 };
async function getTenantAccessToken_() { /* ... (Giữ nguyên code hàm này như file index 2.js) ... */ }
async function callLarkAPI(method, path, payload = null) { /* ... (Giữ nguyên code hàm này như file index 2.js) ... */ }
async function bitableAddRecord_(fields) { /* ... (Giữ nguyên) ... */ }
async function bitableGetRecord_(recordId) { /* ... (Giữ nguyên) ... */ }
async function bitableGetRecordsByEmail_(email) { /* ... (Giữ nguyên) ... */ }
async function bitableListAll_() { /* ... (Giữ nguyên) ... */ }
async function bitableUpdateRecord_(recordId, fields) { /* ... (Giữ nguyên) ... */ }
async function bitableDeleteRecord_(recordId) { /* ... (Giữ nguyên) ... */ }
async function isUserAdmin_(email) { /* ... (Giữ nguyên) ... */ }

// (MỚI) Hàm Proxy tải ảnh lên Drive qua GAS
async function proxyUploadToGAS_(base64Data, fileName) {
    if (!base64Data || !fileName) return null;
    if (!CFG.GAS_UPLOAD_URL) throw new Error("Lỗi cấu hình: Thiếu gas_upload_url");
    try {
        const payload = {
            action: 'uploadImageOnly',
            img1_base64: base64Data,
            img1_name: fileName
        };
        const response = await axios.post(CFG.GAS_UPLOAD_URL, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        const result = response.data;
        if (result.success && result.driveUrl) {
            return result.driveUrl; // Trả về URL Drive
        }
        // (SỬA) Ném lỗi chi tiết từ GAS ra ngoài
        throw new Error(result.error || 'Lỗi API GAS không trả về URL.');
    } catch (e) {
        console.error('Lỗi Proxy tải ảnh lên GAS:', e.message);
        // (SỬA) Ném lỗi ra
        throw new Error("Lỗi Proxy GAS: " + e.message);
    }
}

// (SỬA) Hàm convertFormData (Sử dụng Proxy mới)
async function convertFormDataToLarkFields_(data) {
    const imageUrls = [];
    if (data.img1_base64) {
        // (SỬA) Gọi hàm Proxy mới
        const url1 = await proxyUploadToGAS_(data.img1_base64, data.img1_name);
        if (url1) imageUrls.push(url1);
    }

    // (Logic còn lại giữ nguyên y hệt file index 2.js)
    let sdt = null; let facebook = null;
    const lienHeInput = data.lienHe || "";
    if (lienHeInput.includes('http')) facebook = lienHeInput;
    else sdt = lienHeInput;
    let trangThaiValue = "Chờ duyệt";
    if (data.emailNguoiDang && await isUserAdmin_(data.emailNguoiDang)) {
        trangThaiValue = "Đã duyệt";
    }
    const GROUP_MAP = { "HCMIU": "IU" };
    const groupForm = data.group;
    const groupLark = GROUP_MAP[groupForm] || groupForm;
    const LOAIDO_MAP = { "GPLX (Bằng lái xe)": "GPLX", "Giấy tờ (Chung)": "Giấy tờ" };
    const loaiDoForm = data.loaiDo;
    const loaiDoLark = LOAIDO_MAP[loaiDoForm] || loaiDoForm;
    const fields = {
        "TieuDe": data.tieuDe, "MoTa": data.noiDung, "KhuVuc": data.khuVuc,
        "LoaiTin": data.dangTinLa === 'timdo' ? 'Cần tìm' : 'Nhặt được',
        "TrangThai": trangThaiValue, "LoaiDo": [ loaiDoLark ],
        "LienHe": sdt ? sdt : null, "LinkFacebook": facebook ? facebook : null,
        "EmailNguoiDang": data.emailNguoiDang || null,
        "Latitude": data.latitude || null, "Longitude": data.longitude || null
    };
    if (groupLark && groupLark.trim() !== "") fields["Group"] = [ groupLark ];
    if (imageUrls.length > 0) fields["HinhAnhURL"] = imageUrls[0];
    else if (data.keep_image_url) fields["HinhAnhURL"] = data.keep_image_url;
    else fields["HinhAnhURL"] = null;
    return fields;
}

// --- (Các hàm AI - Giữ nguyên code AI từ file index 2.js) ---
let apiKeyIndex = 0;
function getNextApiKey_() { /* ... (Giữ nguyên) ... */ }
async function scanImageAndParseWithOpenRouter_(base64ImageData) { /* ... (Giữ nguyên) ... */ }
async function chatWithAI_(question, filteredDataJson) { /* ... (Giữ nguyên) ... */ }

// (APP EXPORT)
const app = express();
app.use(cors({ origin: true })); 
app.use(express.json({limit: '20mb'})); 
app.all("/", async (req, res) => {
    // (Giữ nguyên toàn bộ logic app.all từ file index 2.js)
    // ...
});
module.exports = app;
