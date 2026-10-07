import api from './index'

// 获取仪表板统计信息
export function getDashboardStats() {
  return api.get('/admin/dashboard/stats')
}

// 获取管理员用户列表
export function getAdminUsers() {
  return api.get('/admin/admin/users', {
    params: { token: localStorage.getItem('adminToken') }
  })
}

// 创建管理员用户
export function createAdminUser(data) {
  return api.post('/admin/users', {
    ...data,
    token: localStorage.getItem('adminToken')
  })
}

// 删除管理员用户
export function deleteAdminUser(userId) {
  return api.delete(`/admin/admin/users/${userId}`, {
    params: { token: localStorage.getItem('adminToken') }
  })
}