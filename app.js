/*******************  配置区（必改）  *******************/
// TODO: 在这里填你的 GitHub Token / 仓库信息
// 注意：这是在前端暴露的，只适合公司内网／你信任的环境
const GITHUB_TOKEN = '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';
const GITHUB_OWNER = 'file-mugassn';
const GITHUB_REPO  = 'file';
/*******************************************************/

const BIG_FILE_THRESHOLD = 1900 * 1024 * 1024; // 1.9GB 以上走分片上传
const CHUNK_SIZE         = 512  * 1024 * 1024; // 单个分片大小 512MB

// ========== DOM 引用 ==========
const headerUser      = document.getElementById('header-user');
const headerUsername  = document.getElementById('header-username');
const headerTag       = document.getElementById('header-tag');
const btnLogout       = document.getElementById('btn-logout');

const authCard        = document.getElementById('auth-card');
const diskCard        = document.getElementById('disk-card');
const shareCard       = document.getElementById('share-card');

const authMessage     = document.getElementById('auth-message');
const loginForm       = document.getElementById('login-form');

const fileInput       = document.getElementById('file-input');
const btnUpload       = document.getElementById('btn-upload-file');
const btnRefresh      = document.getElementById('btn-refresh');
const btnNewFolder    = document.getElementById('btn-new-folder');
const uploadTarget    = document.getElementById('upload-target');

const uploadProgress  = document.getElementById('upload-progress');
const progressText    = document.getElementById('progress-text');
const progressBarInner= document.getElementById('progress-bar-inner');

const emptyTip        = document.getElementById('empty-tip');
const fileTable       = document.getElementById('file-table');
const fileTbody       = document.getElementById('file-tbody');
const sessionInfo     = document.getElementById('session-info');

const breadcrumbText  = document.getElementById('breadcrumb-text');
const breadcrumbBack  = document.getElementById('breadcrumb-back');

// 分享区域 DOM
const shareTitle      = document.getElementById('share-title');
const shareSubtitle   = document.getElementById('share-subtitle');
const shareDownloadAll= document.getElementById('share-download-all');
const shareCopyAll    = document.getElementById('share-copy-all');
const shareOps        = document.getElementById('share-ops');
const shareEmpty      = document.getElementById('share-empty');
const shareTable      = document.getElementById('share-table');
const shareTbody      = document.getElementById('share-tbody');

// ========== 全局状态 ==========
let currentUsername = '';
let currentTag      = '';      // safe tag for Release
let currentFolder   = '';      // "" / "aaa" / "aaa/bbb"
let extraFolders    = new Set();

let allAssets       = [];      // 解析后的文件数据
let currentRelease  = null;    // 最近一次获取的 Release（包含 assets）

// 分享模式下的文件列表
let shareFiles      = [];

// ========== 工具函数 ==========

function showError(msg, container = authMessage) {
    container.innerHTML = '<div class="error-message">' + msg + '</div>';
}
function showSuccess(msg, container = authMessage) {
    container.innerHTML = '<div class="success-message">' + msg + '</div>';
}

function formatBytes(bytes) {
    const units = ['B','KB','MB','GB','TB'];
    if (!bytes || bytes <= 0) return '0 B';
    let i = Math.floor(Math.log(bytes) / Math.log(1024));
    i = Math.min(i, units.length - 1);
    const value = bytes / Math.pow(1024, i);
    return value.toFixed(2) + ' ' + units[i];
}

function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
    } else {
        return new Promise((resolve, reject) => {
            try {
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    }
}

// 用户名 -> Release tag
function getUserTag(username) {
    return (username || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'user';
}

// 路径标准化，aaa\\bbb -> aaa/bbb
function normalizeFolderPath(folder) {
    folder = (folder || '').trim();
    folder = folder.replace(/\\+/g, '/');
    folder = folder.replace(/\/+/g, '/');
    folder = folder.replace(/^\/+|\/+$/g, '');
    return folder;
}

// aaa/bbb -> aaa__bbb
function encodeFolderPath(folder) {
    folder = normalizeFolderPath(folder);
    if (!folder) return '';
    return folder.replace(/\//g, '__');
}

// aaa__bbb -> aaa/bbb
function decodeFolderPath(folderEnc) {
    if (!folderEnc) return '';
    const folder = folderEnc.replace(/__/g, '/');
    return normalizeFolderPath(folder);
}

// 通用 GitHub API 请求
async function githubRequest(method, url, body, extraHeaders) {
    const headers = Object.assign({
        // 用 token 而不是 Bearer，兼容经典 PAT
        'Authorization': 'token ' + GITHUB_TOKEN,
        'Accept': 'application/vnd.github+json'
    }, extraHeaders || {});

    console.log('[GitHubRequest]', method, url);

    const res = await fetch(url, {
        method,
        headers,
        body
    });

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}

    if (res.status === 401) {
        console.error('GitHub 401 未授权，响应：', text || json);
    }

    return { status: res.status, data: json, text };
}

async function getOrCreateRelease(tag, releaseName) {
    const base = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;
    const url  = `${base}/releases/tags/${encodeURIComponent(tag)}`;

    let resp = await githubRequest('GET', url);
    if (resp.status === 200) return resp.data;

    if (resp.status === 404) {
        const createUrl = `${base}/releases`;
        const body = JSON.stringify({
            tag_name: tag,
            name: releaseName,
            draft: false,
            prerelease: false
        });
        const createResp = await githubRequest('POST', createUrl, body, {
            'Content-Type': 'application/json'
        });
        if (createResp.status === 201) return createResp.data;
    }

    throw new Error('获取或创建 Release 失败，HTTP ' + resp.status);
}

async function getReleaseByTag(tag) {
    const base = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;
    const url  = `${base}/releases/tags/${encodeURIComponent(tag)}`;
    const resp = await githubRequest('GET', url);
    if (resp.status === 200) return resp.data;
    return null;
}

async function deleteAsset(assetId) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/assets/${assetId}`;
    const resp = await githubRequest('DELETE', url);
    return resp.status === 204 || resp.status === 404;
}

async function renameAsset(assetId, newName) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/assets/${assetId}`;
    const body = JSON.stringify({ name: newName });
    const resp = await githubRequest('PATCH', url, body, {
        'Content-Type': 'application/json'
    });
    return resp.status === 200;
}

async function ensureRelease() {
    if (currentRelease) return currentRelease;
    const tag  = currentTag;
    const name = 'User Files - ' + currentUsername;
    const rel  = await getOrCreateRelease(tag, name);
    currentRelease = rel;
    return rel;
}

// ========== 登录 / 会话 ==========

loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = loginForm.username.value.trim();
    if (!username) {
        showError('请输入用户名');
        return;
    }
    currentUsername = username;
    currentTag      = getUserTag(username);

    localStorage.setItem('gh_drive_username', currentUsername);
    enterUser();
});

btnLogout.addEventListener('click', () => {
    localStorage.removeItem('gh_drive_username');
    currentUsername = '';
    currentTag      = '';
    currentRelease  = null;
    allAssets       = [];
    headerUser.style.display = 'none';
    diskCard.style.display   = 'none';
    shareCard.style.display  = 'none';
    authCard.style.display   = '';
});

function enterUser() {
    headerUser.style.display  = 'flex';
    headerUsername.textContent= currentUsername;
    headerTag.textContent     = 'tag: ' + currentTag;

    sessionInfo.innerHTML =
        '<div class="status-chip">' +
        '<div class="status-dot"></div>' +
        '<span>已登录</span>' +
        '</div>' +
        '<div style="margin-top:6px;font-size:12px;color:#6b7280;">' +
        '每个用户名对应一个独立的 GitHub Release，用于隔离文件。' +
        '</div>';

    authCard.style.display = 'none';
    diskCard.style.display = '';
    shareCard.style.display = 'none';

    currentFolder = '';
    extraFolders.clear();
    loadFiles();
}

// ========== 文件列表 ==========

async function loadFiles() {
    try {
        const tag  = currentTag;
        const name = 'User Files - ' + currentUsername;
        const rel  = await getOrCreateRelease(tag, name);

        currentRelease = rel;
        const assets   = rel.assets || [];

        const parsed = parseAssetsFromRelease(assets, tag);
        allAssets    = parsed;
    } catch (e) {
        console.error(e);
        allAssets = [];
    }
    renderFolderView();
}

function parseAssetsFromRelease(assets, tag) {
    const bigGroups    = {}; // groupId => {...}
    const normalAssets = [];
    const result       = [];

    assets.forEach(a => {
        const name = a.name || '';
        const size = a.size || 0;
        const url  = a.browser_download_url || '';
        const id   = a.id;

        // 大文件分片：<base>__group-<gid>__part-0001-of-0003
        const bigMatch = name.match(/^(.*)__group-([a-z0-9\-]+)__part-(\d+)-of-(\d+)$/);
        if (bigMatch) {
            const base      = bigMatch[1];
            const groupId   = bigMatch[2];
            const partIndex = parseInt(bigMatch[3], 10);

            let folderPath   = '';
            let originalName = base;

            if (base.includes('___')) {
                const parts = base.split('___', 2);
                const folderEnc = parts[0];
                originalName = parts[1];
                folderPath   = decodeFolderPath(folderEnc);
            }

            if (!bigGroups[groupId]) {
                bigGroups[groupId] = {
                    folder:        folderPath,
                    original_name: originalName,
                    size_total:    0,
                    parts:         {} // partIndex => {id,size,url}
                };
            }
            if (folderPath && !bigGroups[groupId].folder) {
                bigGroups[groupId].folder = folderPath;
            }
            bigGroups[groupId].size_total += size;
            bigGroups[groupId].parts[partIndex] = { asset_id: id, size, url };
            return;
        }

        // 普通文件：folderEnc___fileName 或 fileName
        let folderPath  = '';
        let displayName = name;

        if (name.includes('___')) {
            const parts = name.split('___', 2);
            const folderEnc = parts[0];
            displayName = parts[1] || name;
            folderPath  = decodeFolderPath(folderEnc);
        }

        normalAssets.push({
            id: id,
            name: name,
            display_name: displayName,
            folder: folderPath,
            size: size,
            browser_download_url: url,
            type: 'normal'
        });
    });

    normalAssets.forEach(na => result.push(na));

    Object.keys(bigGroups).forEach(groupId => {
        const info = bigGroups[groupId];
        const parts = info.parts;
        const partIndices = Object.keys(parts).map(x => parseInt(x, 10)).sort((a,b)=>a-b);

        result.push({
            id: null,
            name: info.original_name,
            display_name: info.original_name,
            folder: info.folder,
            size: info.size_total,
            type: 'big',
            group_id: groupId,
            tag: tag,
            part_ids: partIndices.map(i => parts[i].asset_id)
        });
    });

    return result;
}

function renderFolderView() {
    fileTbody.innerHTML = '';

    if (!currentFolder) {
        breadcrumbText.textContent = '当前位置：/';
        breadcrumbBack.style.display = 'none';
        uploadTarget.textContent = '上传目录：/';
    } else {
        breadcrumbText.textContent = '当前位置：/' + currentFolder;
        breadcrumbBack.style.display = '';
        uploadTarget.textContent = '上传目录：/' + currentFolder;
    }

    const rows        = [];
    const filesHere   = [];
    const childFolders= new Set();

    const current = currentFolder || '';
    const prefixForChild = current ? current + '/' : '';

    allAssets.forEach(a => {
        const folder = a.folder || '';
        if (folder === current) {
            filesHere.push(a);
        } else {
            if (folder.startsWith(prefixForChild)) {
                const rest = folder.slice(prefixForChild.length);
                if (!rest) return;
                const seg = rest.split('/')[0];
                if (seg) childFolders.add(seg);
            }
        }
    });

    extraFolders.forEach(path => {
        if (path === current) return;
        if (!current && !path.includes('/')) {
            childFolders.add(path);
        } else if (path.startsWith(prefixForChild)) {
            const rest = path.slice(prefixForChild.length);
            if (!rest) return;
            const seg = rest.split('/')[0];
            if (seg) childFolders.add(seg);
        }
    });

    Array.from(childFolders).sort().forEach(name => {
        const fullPath = current ? (current + '/' + name) : name;
        rows.push(buildFolderRow(name, fullPath));
    });

    filesHere.forEach(a => rows.push(buildFileRow(a)));

    if (!rows.length) {
        emptyTip.style.display = '';
        fileTable.style.display = 'none';
    } else {
        emptyTip.style.display = 'none';
        fileTable.style.display = '';
        rows.forEach(r => fileTbody.appendChild(r));
    }
}

function buildFolderRow(name, fullPath) {
    const tr = document.createElement('tr');
    tr.className = 'row-folder';

    const tdName = document.createElement('td');
    tdName.textContent = '📁 ' + name;

    const tdSize = document.createElement('td');
    tdSize.textContent = '-';

    const tdDownload = document.createElement('td');
    tdDownload.textContent = '-';

    const tdOps = document.createElement('td');
    tdOps.className = 'ops-col';

    const btnShare = document.createElement('button');
    btnShare.className = 'btn';
    btnShare.textContent = '分享链接';
    btnShare.onclick = (e) => {
        e.stopPropagation();
        const base = window.location.origin + window.location.pathname;
        const link = base + '?share=1'
            + '&u=' + encodeURIComponent(currentTag)
            + '&f=' + encodeURIComponent(fullPath);
        copyToClipboard(link)
            .then(() => alert('文件夹分享链接已复制：\n' + link))
            .catch(() => alert('复制失败，请手动复制：\n' + link));
    };

    const btnMove = document.createElement('button');
    btnMove.className = 'btn';
    btnMove.textContent = '移动';
    btnMove.onclick = (e) => {
        e.stopPropagation();
        alert('当前版本建议通过移动文件的方式来调整目录结构（未实现整目录迁移）。');
    };

    const btnDel = document.createElement('button');
    btnDel.className = 'btn btn-danger';
    btnDel.textContent = '删除';
    btnDel.onclick = (e) => {
        e.stopPropagation();
        if (!confirm(`确定要删除文件夹 "/${fullPath}" 下的所有文件（包括子目录）吗？`)) return;

        const prefix = fullPath + '/';
        const targets = allAssets.filter(a =>
            a.folder === fullPath || (a.folder && a.folder.startsWith(prefix))
        );

        (async () => {
            for (const a of targets) {
                await deleteFileOrGroup(a);
            }
            extraFolders.delete(fullPath);
            if (currentFolder === fullPath) currentFolder = '';
            loadFiles();
        })();
    };

    tdOps.appendChild(btnShare);
    tdOps.appendChild(btnMove);
    tdOps.appendChild(btnDel);

    tr.appendChild(tdName);
    tr.appendChild(tdSize);
    tr.appendChild(tdDownload);
    tr.appendChild(tdOps);

    tr.ondblclick = () => {
        currentFolder = fullPath;
        renderFolderView();
    };

    return tr;
}

function buildFileRow(a) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = a.display_name || a.name;
    if (a.type === 'big') {
        tdName.textContent += ' (大文件)';
    }

    const tdSize = document.createElement('td');
    tdSize.textContent = formatBytes(a.size);

    const tdDownload = document.createElement('td');
    const btnDownload = document.createElement('button');
    btnDownload.className = 'btn btn-primary';
    btnDownload.textContent = '下载';
    btnDownload.onclick = () => {
        if (a.type === 'big') {
            downloadBigFile(a.tag, a.group_id, a.display_name || a.name);
        } else {
            window.open(a.browser_download_url, '_blank');
        }
    };
    tdDownload.appendChild(btnDownload);

    const tdOps = document.createElement('td');
    tdOps.className = 'ops-col';

    const btnShare = document.createElement('button');
    btnShare.className = 'btn';
    btnShare.textContent = '分享链接';
    btnShare.onclick = () => {
        if (a.type === 'big') {
            const base = window.location.origin + window.location.pathname;
            const url  = base + '?share=1'
                + '&u=' + encodeURIComponent(a.tag)
                + '&f=' + encodeURIComponent(a.folder || '');
            alert('目前大文件通过“文件夹分享链接”聚合下载，请将文件夹链接发给对方。');
            copyToClipboard(url).then(()=>{
                alert('文件夹链接已复制：\n' + url);
            }).catch(()=>{
                alert('复制失败，请手动复制：\n' + url);
            });
        } else {
            copyToClipboard(a.browser_download_url)
                .then(() => alert('下载链接已复制到剪贴板'))
                .catch(() => alert('复制失败，请手动复制：\n' + a.browser_download_url));
        }
    };

    const btnMove = document.createElement('button');
    btnMove.className = 'btn';
    btnMove.textContent = '移动';
    btnMove.onclick = () => moveFileOrGroup(a);

    const btnDel = document.createElement('button');
    btnDel.className = 'btn btn-danger';
    btnDel.textContent = '删除';
    btnDel.onclick = () => deleteFileOrGroup(a);

    tdOps.appendChild(btnShare);
    tdOps.appendChild(btnMove);
    tdOps.appendChild(btnDel);

    tr.appendChild(tdName);
    tr.appendChild(tdSize);
    tr.appendChild(tdDownload);
    tr.appendChild(tdOps);

    return tr;
}

// ========== 删除 / 移动 / 大文件下载 ==========

async function deleteFileOrGroup(asset) {
    if (!currentRelease) {
        await ensureRelease();
    }
    const assetsRaw = (currentRelease && currentRelease.assets) || [];

    if (asset.type === 'big') {
        if (!confirm(`确定要删除大文件 "${asset.display_name}" 的所有分片吗？`)) return;
        const pattern = new RegExp(`__group-${asset.group_id}__part-\\d+-of-\\d+$`);
        for (const a of assetsRaw) {
            if (pattern.test(a.name || '')) {
                await deleteAsset(a.id);
            }
        }
        await loadFiles();
        return;
    }

    if (!asset.id) {
        alert('缺少 asset_id');
        return;
    }
    if (!confirm('确定要删除该文件吗？')) return;

    const ok = await deleteAsset(asset.id);
    if (!ok) {
        alert('删除失败');
    }
    await loadFiles();
}

async function moveFileOrGroup(asset) {
    const folder = prompt('请输入目标文件夹路径（支持多级，如 aaa/bbb，留空为根目录）：', asset.folder || '');
    if (folder === null) return;
    const targetFolder = normalizeFolderPath(folder);

    if (!currentRelease) {
        await ensureRelease();
    }
    const assetsRaw = (currentRelease && currentRelease.assets) || [];

    // 移动大文件整组
    if (asset.type === 'big') {
        const groupId = asset.group_id;
        const pattern = new RegExp(`^(.*)__group-${groupId}__part-(\\d+)-of-(\\d+)$`);

        const folderEncNew    = encodeFolderPath(targetFolder);
        const folderPrefixNew = folderEncNew ? (folderEncNew + '___') : '';

        for (const a of assetsRaw) {
            const name = a.name || '';
            const m = name.match(pattern);
            if (!m) continue;

            const base   = m[1]; // 原来的 <folderEncOld>___<originalName> 或 <originalName>
            const suffix = name.substring(base.length); // 从 __group- 开始

            let originalName = base;
            if (base.includes('___')) {
                const parts = base.split('___', 2);
                originalName = parts[1];
            }

            const newName = folderPrefixNew + originalName + suffix;
            await renameAsset(a.id, newName);
        }
        if (targetFolder) extraFolders.add(targetFolder);
        await loadFiles();
        return;
    }

    // 移动普通文件
    if (!asset.id) {
        alert('缺少 asset_id');
        return;
    }

    const targetRaw = assetsRaw.find(x => x.id === asset.id);
    if (!targetRaw) {
        alert('未找到对应文件');
        return;
    }

    const origName = targetRaw.name;
    let origDisplay = origName;
    if (origName.includes('___')) {
        origDisplay = origName.split('___', 2)[1];
    }

    const folderEncNew    = encodeFolderPath(targetFolder);
    const folderPrefixNew = folderEncNew ? (folderEncNew + '___') : '';
    const newName = folderPrefixNew + origDisplay;

    const ok = await renameAsset(asset.id, newName);
    if (!ok) {
        alert('移动失败（改名失败）');
        return;
    }
    if (targetFolder) extraFolders.add(targetFolder);
    await loadFiles();
}

// 大文件聚合下载（浏览器拼接所有分片）
async function downloadBigFile(tag, groupId, originalName) {
    try {
        const rel = await getReleaseByTag(tag);
        if (!rel || !rel.assets || !rel.assets.length) {
            alert('找不到对应的 Release 或分片');
            return;
        }
        const assetsRaw = rel.assets;
        const pattern = new RegExp(`^(.*)__group-${groupId}__part-(\\d+)-of-(\\d+)$`);
        const parts = [];

        for (const a of assetsRaw) {
            const name = a.name || '';
            const m = name.match(pattern);
            if (!m) continue;
            const partIndex = parseInt(m[2], 10);
            parts.push({ index: partIndex, id: a.id });
        }

        if (!parts.length) {
            alert('未找到任何分片');
            return;
        }
        parts.sort((a,b)=>a.index-b.index);

        if (!confirm(`该文件包含 ${parts.length} 个分片，将在浏览器中拼接后下载。\n若文件很大，可能占用较多内存。继续？`)) {
            return;
        }

        const chunks = [];
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            progressText.textContent = `正在下载分片 ${i+1}/${parts.length}...`;
            uploadProgress.style.display = '';
            progressBarInner.style.width = Math.round((i / parts.length)*100) + '%';

            const blob = await fetchAssetBlob(p.id);
            chunks.push(blob);
        }

        const blob = new Blob(chunks, { type: 'application/octet-stream' });
        const url  = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = originalName || 'bigfile.bin';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        progressBarInner.style.width = '100%';
        progressText.textContent = '下载完成';
        setTimeout(()=>{
            uploadProgress.style.display = 'none';
            progressBarInner.style.width = '0%';
        }, 2000);
    } catch (e) {
        console.error(e);
        alert('大文件下载失败：' + e);
        uploadProgress.style.display = 'none';
        progressBarInner.style.width = '0%';
    }
}

async function fetchAssetBlob(assetId) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/assets/${assetId}`;
    const headers = {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'Accept': 'application/octet-stream'
    };
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
        const text = await res.text();
        throw new Error('下载分片失败 HTTP ' + res.status + '：' + text);
    }
    return await res.blob();
}

// ========== 上传相关（整文件 + 分片） ==========

btnRefresh.addEventListener('click', () => loadFiles());

btnNewFolder.addEventListener('click', () => {
    const name = prompt('新建文件夹名称（当前目录下，例如：bbb）：', '');
    if (name === null) return;
    const clean = name.trim().replace(/[/\\]+/g, '');
    if (!clean) return;

    const fullPath = currentFolder ? (currentFolder + '/' + clean) : clean;
    extraFolders.add(fullPath);
    currentFolder = fullPath;
    renderFolderView();
});

btnUpload.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', () => {
    const files = fileInput.files;
    if (!files || !files.length) return;
    const folder = currentFolder || '';
    uploadMultipleFiles(Array.from(files), folder);
});

async function uploadMultipleFiles(files, folder) {
    btnUpload.disabled = true;
    uploadProgress.style.display = '';
    progressBarInner.style.width = '0%';
    progressText.textContent = `正在上传 (1/${files.length})：0%`;

    try {
        for (let i = 0; i < files.length; i++) {
            await uploadSingleFile(files[i], folder, i, files.length);
        }
        fileInput.value = '';
        await loadFiles();
        progressBarInner.style.width = '100%';
        progressText.textContent = '全部上传完成';
    } catch (e) {
        console.error(e);
        progressText.textContent = '上传失败：' + e;
    } finally {
        btnUpload.disabled = false;
        setTimeout(() => {
            uploadProgress.style.display = 'none';
            progressBarInner.style.width = '0%';
        }, 2000);
    }
}

async function uploadSingleFile(file, folder, index, total) {
    if (file.size <= BIG_FILE_THRESHOLD) {
        return uploadWholeFile(file, folder, index, total);
    }
    return uploadLargeFileInChunks(file, folder, index, total);
}

function uploadWholeFile(file, folder, fileIndex, fileTotal) {
    return new Promise(async (resolve, reject) => {
        try {
            const rel = await ensureRelease();
            const folderEnc    = encodeFolderPath(folder);
            const folderPrefix = folderEnc ? (folderEnc + '___') : '';
            const assetName    = folderPrefix + file.name;

            const url = `https://uploads.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(assetName)}`;

            const xhr = new XMLHttpRequest();
            xhr.open('POST', url);
            xhr.setRequestHeader('Authorization', 'token ' + GITHUB_TOKEN);
            xhr.setRequestHeader('Accept', 'application/vnd.github+json');
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');

            xhr.upload.onprogress = function(event) {
                if (event.lengthComputable) {
                    const percent = Math.round((event.loaded / event.total) * 100);
                    progressBarInner.style.width = percent + '%';
                    progressText.textContent = `正在上传 (${fileIndex+1}/${fileTotal})：${percent}%`;
                }
            };

            xhr.onreadystatechange = function() {
                if (xhr.readyState === 4) {
                    if (xhr.status === 201) {
                        resolve();
                    } else {
                        reject('HTTP ' + xhr.status + '：' + xhr.responseText);
                    }
                }
            };

            xhr.onerror = () => reject('网络错误');
            xhr.send(file);
        } catch (e) {
            reject(e);
        }
    });
}

async function uploadLargeFileInChunks(file, folder, fileIndex, fileTotal) {
    const chunkTotal = Math.ceil(file.size / CHUNK_SIZE);
    const groupId    = Date.now() + '-' + Math.random().toString(16).slice(2);
    const originalName = file.name;

    for (let chunkIndex = 0; chunkIndex < chunkTotal; chunkIndex++) {
        const start = chunkIndex * CHUNK_SIZE;
        const end   = Math.min(start + CHUNK_SIZE, file.size);
        const blob  = file.slice(start, end);

        await uploadOneChunk(
            blob,
            { folder, groupId, originalName, chunkIndex, chunkTotal, fileSize: file.size },
            fileIndex,
            fileTotal
        );
    }
}

function uploadOneChunk(blob, meta, fileIndex, fileTotal) {
    return new Promise(async (resolve, reject) => {
        try {
            const rel = await ensureRelease();
            const folderEnc    = encodeFolderPath(meta.folder || '');
            const folderPrefix = folderEnc ? (folderEnc + '___') : '';

            const partNo   = meta.chunkIndex + 1;
            const partStr  = String(partNo).padStart(4, '0');
            const totalStr = String(meta.chunkTotal).padStart(4, '0');

            const assetName = folderPrefix
                + meta.originalName
                + '__group-' + meta.groupId
                + '__part-' + partStr + '-of-' + totalStr;

            const url = `https://uploads.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(assetName)}`;

            const xhr = new XMLHttpRequest();
            xhr.open('POST', url);
            xhr.setRequestHeader('Authorization', 'token ' + GITHUB_TOKEN);
            xhr.setRequestHeader('Accept', 'application/vnd.github+json');
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');

            xhr.upload.onprogress = function(event) {
                if (event.lengthComputable) {
                    const chunkProgress = event.loaded / event.total;
                    const fileProgress  = (meta.chunkIndex + chunkProgress) / meta.chunkTotal;
                    const percent       = Math.round(fileProgress * 100);
                    progressBarInner.style.width = percent + '%';
                    progressText.textContent =
                        `正在上传大文件 (${fileIndex+1}/${fileTotal})：分片 ${meta.chunkIndex+1}/${meta.chunkTotal}，${percent}%`;
                }
            };

            xhr.onreadystatechange = function() {
                if (xhr.readyState === 4) {
                    if (xhr.status === 201) {
                        resolve();
                    } else {
                        reject('HTTP ' + xhr.status + '：' + xhr.responseText);
                    }
                }
            };

            xhr.onerror = () => reject('网络错误');
            xhr.send(blob);
        } catch (e) {
            reject(e);
        }
    });
}

// ========== 面包屑返回 ==========

breadcrumbBack.addEventListener('click', () => {
    if (!currentFolder) return;
    const parts = currentFolder.split('/');
    parts.pop();
    currentFolder = parts.join('/');
    renderFolderView();
});

// ========== 分享模式 ==========

function parseQuery() {
    const q = {};
    const s = window.location.search.slice(1).split('&');
    s.forEach(p => {
        if (!p) return;
        const [k,v] = p.split('=');
        q[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });
    return q;
}

async function initShareMode(params) {
    authCard.style.display  = 'none';
    diskCard.style.display  = 'none';
    shareCard.style.display = '';

    headerUser.style.display = 'none';

    const tag = (params.u || '').trim();
    const folderPath = normalizeFolderPath(params.f || '');

    if (!tag || !folderPath) {
        shareSubtitle.textContent = '参数不完整（需要 u 和 f）。';
        shareEmpty.style.display  = '';
        shareTable.style.display  = 'none';
        shareOps.style.display    = 'none';
        return;
    }

    shareTitle.textContent = '文件夹分享：/' + folderPath;
    shareSubtitle.textContent = '正在加载...';

    try {
        const rel = await getReleaseByTag(tag);
        if (!rel || !rel.assets || !rel.assets.length) {
            shareSubtitle.textContent = '未找到对应的 Release 或该文件夹下暂无文件。';
            shareEmpty.style.display  = '';
            shareTable.style.display  = 'none';
            shareOps.style.display    = 'none';
            return;
        }

        const folderEnc = encodeFolderPath(folderPath);
        const prefix    = folderEnc + '___';

        const assets = rel.assets;
        const files  = [];
        const bigGroups = {};

        assets.forEach(a => {
            const name = a.name || '';
            const url  = a.browser_download_url || '';
            const size = a.size || 0;

            if (!name.startsWith(prefix)) return;
            const rest = name.substring(prefix.length);

            const m = rest.match(/(.*)__group-([a-z0-9\-]+)__part-(\d+)-of-(\d+)/);
            if (m) {
                const originalName = m[1];
                const groupId      = m[2];
                const partIndex    = parseInt(m[3],10);

                if (!bigGroups[groupId]) {
                    bigGroups[groupId] = {
                        original_name: originalName,
                        size_total: 0,
                        parts: {}
                    };
                }
                bigGroups[groupId].size_total += size;
                bigGroups[groupId].parts[partIndex] = {
                    id: a.id,
                    size,
                    url
                };
                return;
            }

            files.push({
                name: rest,
                url: url,
                size: size,
                type: 'normal'
            });
        });

        Object.keys(bigGroups).forEach(gid => {
            const info = bigGroups[gid];
            files.push({
                name: info.original_name + ' (大文件)',
                url: '',
                size: info.size_total,
                type: 'big',
                group_id: gid,
                tag: tag,
                original_name: info.original_name
            });
        });

        shareFiles = files;

        if (!files.length) {
            shareSubtitle.textContent = '该文件夹下暂无文件。';
            shareEmpty.style.display  = '';
            shareTable.style.display  = 'none';
            shareOps.style.display    = 'none';
            return;
        }

        shareSubtitle.textContent = '共 ' + files.length + ' 个文件';
        shareEmpty.style.display  = 'none';
        shareTable.style.display  = '';
        shareOps.style.display    = '';

        shareTbody.innerHTML = '';
        files.forEach(f => {
            const tr = document.createElement('tr');
            const tdName = document.createElement('td');
            tdName.textContent = f.name;
            const tdOps  = document.createElement('td');

            const btnDown = document.createElement('button');
            btnDown.className = 'btn btn-primary';
            btnDown.textContent = '下载';
            btnDown.onclick = () => {
                if (f.type === 'big') {
                    downloadBigFile(f.tag, f.group_id, f.original_name);
                } else {
                    const a = document.createElement('a');
                    a.href = f.url;
                    a.download = '';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                }
            };

            const btnCopy = document.createElement('button');
            btnCopy.className = 'btn';
            btnCopy.textContent = '复制链接';
            btnCopy.onclick = () => {
                if (f.type === 'big') {
                    alert('大文件为分片聚合下载，此模式暂不提供单条直链。');
                } else {
                    copyToClipboard(f.url)
                        .then(()=>alert('已复制该文件下载链接'))
                        .catch(()=>alert('复制失败，请手动复制：\n' + f.url));
                }
            };

            tdOps.appendChild(btnDown);
            tdOps.appendChild(btnCopy);

            tr.appendChild(tdName);
            tr.appendChild(tdOps);
            shareTbody.appendChild(tr);
        });

        shareDownloadAll.onclick = () => {
            let delay = 0;
            shareFiles.forEach(f => {
                setTimeout(() => {
                    if (f.type === 'big') {
                        downloadBigFile(f.tag, f.group_id, f.original_name);
                    } else {
                        const a = document.createElement('a');
                        a.href = f.url;
                        a.download = '';
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                    }
                }, delay);
                delay += 250;
            });
        };

        shareCopyAll.onclick = () => {
            const list = shareFiles
                .filter(f => f.type === 'normal')
                .map(f => f.url)
                .join('\n');
            if (!list) {
                alert('当前文件列表中没有可直接复制直链的普通文件。');
                return;
            }
            copyToClipboard(list)
                .then(()=>alert('已复制所有普通文件的下载链接'))
                .catch(()=>alert('复制失败，请手动复制：\n' + list));
        };
    } catch (e) {
        console.error(e);
        shareSubtitle.textContent = '加载失败：' + e;
        shareEmpty.style.display  = '';
        shareTable.style.display  = 'none';
        shareOps.style.display    = 'none';
    }
}

// ========== 初始化 ==========

(function init() {
    const params = parseQuery();
    if (params.share === '1') {
        // 分享模式
        initShareMode(params);
        return;
    }

    // 普通模式
    const storedUser = localStorage.getItem('gh_drive_username');
    if (storedUser) {
        currentUsername = storedUser;
        currentTag      = getUserTag(currentUsername);
        enterUser();
    } else {
        authCard.style.display = '';
        diskCard.style.display = 'none';
        shareCard.style.display = 'none';
    }
})();
