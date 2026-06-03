module.exports = {
  apps: [{
    name: 'ezNote',
    script: 'server.js',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      // WebDAV 备份配置
      WEBDAV_URL: 'https://your-webdav-server.com/dav',
      WEBDAV_USER: 'your-username',
      WEBDAV_PASSWORD: 'your-password',
      BACKUP_NAME: 'ezNote-backup',
      ENABLE_BACKUP: 'true'
    }
  }]
}
