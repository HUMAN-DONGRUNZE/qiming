import api from './index'

// 获取赛事列表
export function fetchCompetitions(params = {}) {
  return api.get('/competitions/', { params })
}

// 获取最新赛事
export function fetchLatestCompetitions(limit = 6) {
  return api.get('/competitions/latest', { params: { limit } })
}

// 获取单个赛事详情
export function fetchCompetitionById(id) {
  return api.get(`/competitions/${id}`)
}

// 创建赛事
export function createCompetition(data) {
  return api.post('/competitions/', data)
}

// 更新赛事
export function updateCompetition(id, data) {
  return api.put(`/competitions/${id}`, data)
}

// 删除赛事
export function deleteCompetition(id) {
  return api.delete(`/competitions/${id}`)
}

// 获取赛事统计信息
export function fetchCompetitionStats() {
  return api.get('/competitions/stats/overview')
}

// 生成赛事URL
export function createCompetitionURL(id) {
  return `/competitions/${id}`
}