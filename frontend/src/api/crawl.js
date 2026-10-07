import api from './index'

// 启动爬虫任务
export function startCrawl(params) {
  return api.post('/crawl/start', null, { 
    params: {
      platform: params.platform,
      urls: params.urls.join(',')
    }
  })
}

// 停止爬虫任务
export function stopCrawl(platform) {
  return api.post('/crawl/stop', null, { params: { platform } })
}

// 获取爬虫状态
export function getCrawlerStatus() {
  return api.get('/admin/crawler/status')
}

// 获取爬虫日志
export function getCrawlerLogs(params = {}) {
  return api.get('/admin/crawler/logs', { params })
}

// 获取爬虫配置
export function getCrawlerConfigs() {
  return api.get('/admin/crawler/configs')
}

// 更新爬虫配置
export function updateCrawlerConfig(data) {
  return api.post('/admin/crawler/configs', data)
}

// 获取爬虫任务列表
export function getCrawlTasks(params = {}) {
  return api.get('/crawl/tasks', { params })
}

// 获取爬虫任务详情
export function getCrawlTask(id) {
  return api.get(`/crawl/tasks/${id}`)
}

// 停止爬虫任务
export function stopCrawlTask(id) {
  return api.post(`/crawl/tasks/${id}/stop`)
}

// 获取可用爬取平台
export function getAvailablePlatforms() {
  return api.get('/crawl/platforms')
}

// 获取爬虫统计信息
export function getCrawlStats() {
  return api.get('/crawl/stats')
}