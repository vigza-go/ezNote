// 复制为 ecosystem.config.js 后填入真实值（该文件已被 .gitignore 忽略，不会提交）
module.exports = {
  apps: [{
    name: 'ezNote',
    script: 'server.js',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      // 登录鉴权（必填，否则无法登录）
      AUTH_TOKEN: 'change-me-to-a-long-random-token',
      AUTH_USER: 'vigza',
      AUTH_PASS: 'change-me-to-a-strong-password',
      // WebDAV 备份（留空则跳过备份）
      WEBDAV_URL: 'https://your-webdav-server.com/dav',
      WEBDAV_USER: 'your-username',
      WEBDAV_PASSWORD: 'your-password',
      BACKUP_NAME: 'ezNote-backup',
      ENABLE_BACKUP: 'true'
    }
  }]
}