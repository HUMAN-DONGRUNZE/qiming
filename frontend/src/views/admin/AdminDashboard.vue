<template>
  <div class="admin-dashboard">
    <div class="dashboard-header">
      <h1>管理控制台</h1>
      <div class="user-info">
        <el-avatar :size="40" src="https://cube.elemecdn.com/0/88/03b0d39583f48206768a7534e55bcpng.png" />
        <span class="username">管理员</span>
        <el-button type="danger" size="small" @click="handleLogout">退出登录</el-button>
      </div>
    </div>

    <div class="dashboard-content">
      <!-- 统计卡片 -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon" style="background: #e6f7ff;">
            <el-icon style="color: #1890ff;"><Document /></el-icon>
          </div>
          <div class="stat-info">
            <div class="stat-value">{{ stats.total }}</div>
            <div class="stat-label">赛事总数</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon" style="background: #f6ffed;">
            <el-icon style="color: #52c41a;"><User /></el-icon>
          </div>
          <div class="stat-info">
            <div class="stat-value">{{ stats.todayRegistrations }}</div>
            <div class="stat-label">今日报名</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon" style="background: #fff7e6;">
            <el-icon style="color: #fa8c16;"><Calendar /></el-icon>
          </div>
          <div class="stat-info">
            <div class="stat-value">{{ stats.pendingReview }}</div>
            <div class="stat-label">待审核</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon" style="background: #fff1f0;">
            <el-icon style="color: #f5222d;"><Download /></el-icon>
          </div>
          <div class="stat-info">
            <div class="stat-value">{{ stats.crawledToday }}</div>
            <div class="stat-label">今日爬取</div>
          </div>
        </div>
      </div>

      <!-- 爬虫控制面板 -->
      <el-card class="crawler-panel">
        <template #header>
          <div class="panel-header">
            <div class="panel-title">赛事信息爬虫控制</div>
            <el-tag :type="crawlerStatus.type">{{ crawlerStatus.text }}</el-tag>
          </div>
        </template>

        <div class="crawler-actions">
          <el-button type="primary" :icon="Play" @click="startCrawl" :disabled="crawlerStatus.running">
            开始爬取
          </el-button>
          <el-button type="success" :icon="Refresh" @click="refreshCrawlerConfig" :disabled="crawlerStatus.running">
            刷新配置
          </el-button>
          <el-button type="warning" :icon="RefreshLeft" @click="stopCrawl" :disabled="!crawlerStatus.running">
            停止爬取
          </el-button>
        </div>

        <el-divider />

        <div class="crawler-stats">
          <el-row :gutter="20">
            <el-col :span="8">
              <div class="crawler-stat">
                <div class="stat-name">已爬取数据</div>
                <div class="stat-num">{{ crawlerStats.totalCount }}</div>
              </div>
            </el-col>
            <el-col :span="8">
              <div class="crawler-stat">
                <div class="stat-name">成功率</div>
                <div class="stat-num">{{ crawlerStats.successRate }}%</div>
              </div>
            </el-col>
            <el-col :span="8">
              <div class="crawler-stat">
                <div class="stat-name">平均耗时</div>
                <div class="stat-num">{{ crawlerStats.avgTime }}ms</div>
              </div>
            </el-col>
          </el-row>
        </div>

        <el-divider />

        <div class="log-container">
          <div class="log-title">运行日志</div>
          <div class="log-content" v-loading="crawlerStatus.running">
            <div v-for="(log, index) in logs" :key="index" class="log-item">
              <span class="log-time">{{ log.time }}</span>
              <span class="log-message">{{ log.message }}</span>
            </div>
            <div v-if="crawlerStatus.running" class="log-item">
              <span class="log-time">...</span>
              <span class="log-message">正在爬取数据...</span>
            </div>
            <div v-if="logs.length === 0" class="log-empty">
              暂无日志
            </div>
          </div>
        </div>
      </el-card>

      <!-- 快捷操作 -->
      <div class="quick-actions">
        <div class="action-item" @click="router.push('/admin/competitions')">
          <el-icon :size="40" color="#1890ff"><Files /></el-icon>
          <div class="action-text">赛事管理</div>
        </div>
        <div class="action-item">
          <el-icon :size="40" color="#52c41a"><Setting /></el-icon>
          <div class="action-text">爬虫配置</div>
        </div>
        <div class="action-item">
          <el-icon :size="40" color="#fa8c16"><DataAnalysis /></el-icon>
          <div class="action-text">数据统计</div>
        </div>
        <div class="action-item">
          <el-icon :size="40" color="#f5222d"><Notebook /></el-icon>
          <div class="action-text">系统公告</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Document, User, Calendar, Download, Play, Refresh, RefreshLeft,
  Files, Setting, DataAnalysis, Notebook
} from '@element-plus/icons-vue'

const router = useRouter()
const autoLogInterval = ref(null)

// 统计数据
const stats = ref({
  total: 1234,
  todayRegistrations: 56,
  pendingReview: 12,
  crawledToday: 234
})

// 爬虫状态
const crawlerStatus = ref({
  running: false,
  text: '未启动',
  type: 'info'
})

// 爬虫统计
const crawlerStats = ref({
  totalCount: 5234,
  successRate: 96.5,
  avgTime: 450
})

// 日志
const logs = ref([])

// 添加日志
const addLog = (message) => {
  const now = new Date()
  logs.value.unshift({
    time: now.toLocaleTimeString(),
    message
  })
  // 保持最多50条日志
  if (logs.value.length > 50) {
    logs.value = logs.value.slice(0, 50)
  }
}

// 退出登录
const handleLogout = async () => {
  try {
    await ElMessageBox.confirm('确定要退出登录吗？', '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    localStorage.removeItem('adminToken')
    router.push('/admin/login')
    ElMessage.success('已退出登录')
  } catch (error) {
    // 用户取消
  }
}

// 启动爬虫
const startCrawl = async () => {
  try {
    const { value: platforms } = await ElMessageBox.prompt('请输入要爬取的平台（多个平台用逗号分隔）', '选择爬取平台', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputPlaceholder: '例如: 教育部, 创新大赛, 竞赛管家',
      inputType: 'text',
      inputValue: '教育部,创新大赛,竞赛管家',
      inputValidator: (value) => {
        if (!value || value.trim() === '') {
          return '请至少选择一个平台'
        }
        return true
      }
    })

    crawlerStatus.value.running = true
    crawlerStatus.value.text = '运行中'
    crawlerStatus.value.type = 'success'
    addLog(`开始爬取 ${platforms} 的数据`)

    // 模拟爬取过程
    let count = 0
    autoLogInterval.value = setInterval(() => {
      count++
      addLog(`正在爬取第 ${count} 个平台...`)
    }, 2000)

    // 模拟完成
    setTimeout(() => {
      crawlerStatus.value.running = false
      crawlerStatus.value.text = '已完成'
      crawlerStatus.value.type = 'info'
      crawlerStats.value.totalCount += 100
      stats.value.crawledToday += 100
      addLog('爬取完成，新增 100 条数据')
      ElMessage.success('爬取任务完成！')
    }, 5000)
  } catch (error) {
    crawlerStatus.value.running = false
  }
}

// 停止爬虫
const stopCrawl = () => {
  crawlerStatus.value.running = false
  crawlerStatus.value.text = '已停止'
  crawlerStatus.value.type = 'warning'
  addLog('用户手动停止了爬取任务')
  if (autoLogInterval.value) {
    clearInterval(autoLogInterval.value)
    autoLogInterval.value = null
  }
}

// 刷新配置
const refreshCrawlerConfig = () => {
  addLog('刷新爬虫配置...')
  setTimeout(() => {
    addLog('配置刷新完成')
    ElMessage.success('配置已更新')
  }, 1000)
}

onMounted(() => {
  addLog('管理控制台初始化完成')
})

onUnmounted(() => {
  if (autoLogInterval.value) {
    clearInterval(autoLogInterval.value)
  }
})
</script>

<style scoped>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

.admin-dashboard {
  min-height: calc(100vh - 345px);
  background: #f5f7fa;
  padding: 2rem;
}

.dashboard-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2rem;
}

.dashboard-header h1 {
  font-size: 2rem;
  font-weight: 700;
  color: #333;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.username {
  font-size: 1rem;
  color: #666;
}

.dashboard-content {
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1.5rem;
}

.stat-card {
  background: white;
  border-radius: 12px;
  padding: 1.5rem;
  display: flex;
  align-items: center;
  gap: 1.5rem;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
}

.stat-icon {
  width: 60px;
  height: 60px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.stat-icon .el-icon {
  font-size: 32px;
}

.stat-info {
  flex: 1;
}

.stat-value {
  font-size: 2rem;
  font-weight: 700;
  color: #333;
  margin-bottom: 0.25rem;
}

.stat-label {
  font-size: 0.9rem;
  color: #666;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.panel-title {
  font-size: 1.25rem;
  font-weight: 700;
  color: #333;
}

.crawler-actions {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}

.crawler-stats {
  margin-bottom: 1.5rem;
}

.crawler-stat {
  background: #f5f7fa;
  border-radius: 8px;
  padding: 1.5rem;
  text-align: center;
}

.stat-name {
  color: #666;
  font-size: 0.9rem;
  margin-bottom: 0.5rem;
}

.stat-num {
  font-size: 1.8rem;
  font-weight: 700;
  color: #333;
}

.log-container {
  border: 1px solid #eee;
  border-radius: 8px;
  overflow: hidden;
}

.log-title {
  background: #f5f7fa;
  padding: 1rem;
  font-weight: 600;
  color: #333;
}

.log-content {
  max-height: 400px;
  overflow-y: auto;
  background: #fafafa;
  padding: 1rem;
}

.log-item {
  display: flex;
  gap: 1rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid #f0f0f0;
  font-family: monospace;
  font-size: 0.9rem;
}

.log-time {
  color: #999;
  white-space: nowrap;
}

.log-message {
  flex: 1;
}

.log-empty {
  text-align: center;
  color: #999;
  padding: 2rem;
}

.quick-actions {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1.5rem;
}

.action-item {
  background: white;
  border-radius: 12px;
  padding: 2rem;
  text-align: center;
  cursor: pointer;
  transition: all 0.3s;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
}

.action-item:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.12);
}

.action-text {
  margin-top: 1rem;
  font-weight: 600;
  color: #333;
}

.el-divider {
  margin: 1rem 0;
}
</style>
