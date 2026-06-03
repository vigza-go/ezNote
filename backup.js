const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');
const { execSync } = require('child_process');

// ============ 配置区 ============
const WEBDAV_URL = process.env.WEBDAV_URL || 'https://pan.vigza.top/dav';
const WEBDAV_USERNAME = process.env.WEBDAV_USER || '1130684907@qq.com';
const WEBDAV_PASSWORD = process.env.WEBDAV_PASS || 'UeClXGKWjwNy2PqCEWt7YFixRtHKCxkq';
const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_NAME = process.env.BACKUP_NAME || 'ezNote-backup';
const MAX_RETRIES = 10;
const BASE_DELAY_MS = 1000;
// ================================

async function uploadWithRetry(webdavClient, remotePath, data, retries = MAX_RETRIES) {
  for (let i = 1; i <= retries; i++) {
    try {
      await webdavClient.putFileContents(remotePath, data, { format: 'binary' });
      return { success: true };
    } catch (err) {
      const delay = BASE_DELAY_MS * Math.pow(2, i - 1);
      console.error(`[${new Date().toISOString()}] 上传失败 (${i}/${retries}):`, err.message);
      if (i < retries) {
        console.log(`[${new Date().toISOString()}] ${delay/1000}秒后重试...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        return { success: false, error: err };
      }
    }
  }
}

async function createBackup() {
  const tempBackupDir = path.join(__dirname, `temp_backup_${Date.now()}`);
  const zipName = `${BACKUP_NAME}.zip`;
  const zipPath = path.join(__dirname, zipName);

  console.log(`[${new Date().toISOString()}] 开始备份...`);

  try {
    // 1. 创建临时备份目录
    fs.mkdirSync(tempBackupDir, { recursive: true });

    // 2. 复制 data 目录到临时目录
    copyDirRecursive(DATA_DIR, path.join(tempBackupDir, 'data'));

    // 3. 打包成 zip（覆盖模式）
    execSync(`cd "${tempBackupDir}" && zip -r "${zipPath}" .`, { stdio: 'pipe' });

    // 4. 上传到 WebDAV（直接覆盖）
    const { createClient } = await import('webdav');
    const webdavClient = createClient(WEBDAV_URL, {
      username: WEBDAV_USERNAME,
      password: WEBDAV_PASSWORD,
      agent: new (require('https').Agent)({
        rejectUnauthorized: false
      }),
    });

    const fileData = fs.readFileSync(zipPath);
    const result = await uploadWithRetry(webdavClient, `/${BACKUP_NAME}.zip`, fileData);

    if (result.success) {
      console.log(`[${new Date().toISOString()}] 备份成功: /${BACKUP_NAME}.zip`);
    } else {
      console.error(`[${new Date().toISOString()}] 备份失败:`, result.error.message);
    }

    // 5. 清理本地临时文件
    fs.rmSync(tempBackupDir, { recursive: true, force: true });
    fs.unlinkSync(zipPath);

  } catch (err) {
    console.error(`[${new Date().toISOString()}] 备份失败:`, err.message);
  }
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ============ 定时任务 ============
// 每天凌晨 3:00 执行备份
const rule = new schedule.RecurrenceRule();
rule.hour = 3;
rule.minute = 0;

schedule.scheduleJob(rule, () => {
  createBackup();
});

console.log('WebDAV 定时备份已启动，每天凌晨 3:00 执行');

// 启动时立即执行一次备份
createBackup();

module.exports = { createBackup };
