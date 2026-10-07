<template>
  <div class="competition-detail">
    <div v-loading="loading" class="detail-content">
      <!-- 赛事头部 -->
      <div class="detail-header">
        <el-tag :type="getTagType(competition.status)" size="large" class="status-tag">
          {{ competition.status }}
        </el-tag>
        <div class="header-actions">
          <el-tag type="info" class="category-tag">{{ competition.category }}</el-tag>
          <el-tag type="success" class="platform-tag">{{ competition.dataSource }}</el-tag>
        </div>
      </div>

      <div class="detail-body">
        <!-- 基本信息 -->
        <el-card class="detail-card">
          <template #header>
            <div class="card-header">
              <h2>赛事信息</h2>
            </div>
          </template>

          <div class="info-grid">
            <div class="info-item">
              <span class="info-label">赛事标题</span>
              <span class="info-value">{{ competition.title }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">赛事类别</span>
              <span class="info-value">{{ competition.category }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">举办时间</span>
              <span class="info-value">{{ competition.startDate }} - {{ competition.endDate }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">举办地点</span>
              <span class="info-value">{{ competition.location }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">报名开始时间</span>
              <span class="info-value">{{ competition.registrationStartDate }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">报名截止时间</span>
              <span class="info-value">{{ competition.registrationEndDate }}</span>
            </div>
            <div class="info-item full-width">
              <span class="info-label">赛事简介</span>
              <div class="info-desc">{{ competition.description }}</div>
            </div>
          </div>
        </el-card>

        <!-- 报名信息 -->
        <el-card class="detail-card">
          <template #header>
            <div class="card-header">
              <h2>报名信息</h2>
            </div>
          </template>

          <div class="info-grid">
            <div class="info-item">
              <span class="info-label">报名状态</span>
              <el-tag :type="registrationStatusType">{{ registrationStatus }}</el-tag>
            </div>
            <div class="info-item">
              <span class="info-label">已报名人数</span>
              <span class="info-value">{{ competition.participants }} 人</span>
            </div>
            <div class="info-item">
              <span class="info-label">报名费用</span>
              <span class="info-value">{{ competition.registrationFee }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">组织单位</span>
              <span class="info-value">{{ competition.organizer }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">指导单位</span>
              <span class="info-value">{{ competition.guidingOrganization || '暂无' }}</span>
            </div>
            <div class="info-item full-width">
              <span class="info-label">报名方式</span>
              <div class="info-desc">{{ competition.registrationMethod }}</div>
            </div>
          </div>

          <div class="registration-actions" v-if="canRegister">
            <el-button type="primary" size="large" @click="handleRegister">
              立即报名
            </el-button>
            <el-button size="large" @click="shareCompetition">
              分享赛事
            </el-button>
          </div>
        </el-card>

        <!-- 赛事详情 -->
        <el-card class="detail-card">
          <template #header>
            <div class="card-header">
              <h2>赛事详情</h2>
            </div>
          </template>

          <div v-html="competition.details" class="details-content"></div>
        </el-card>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchCompetitionById } from '@/api/competition'

const route = useRoute()
const router = useRouter()

// 数据
const competition = ref({})
const loading = ref(false)

// 标签类型
const getTagType = (status) => {
  const types = {
    '招募中': 'success',
    '报名中': 'warning',
    '即将开始': 'info',
    '已结束': 'danger'
  }
  return types[status] || 'info'
}

// 报名状态
const registrationStatus = ref('')
const registrationStatusType = ref('')
const canRegister = ref(false)

const loadCompetition = async () => {
  try {
    loading.value = true
    const id = route.params.id
    const response = await fetchCompetitionById(id)
    competition.value = response.data

    // 判断报名状态
    const now = new Date()
    const registrationStart = new Date(competition.value.registrationStartDate)
    const registrationEnd = new Date(competition.value.registrationEndDate)
    const startDate = new Date(competition.value.startDate)

    if (now < registrationStart) {
      registrationStatus.value = '报名尚未开始'
      registrationStatusType.value = 'info'
      canRegister.value = false
    } else if (now > registrationEnd) {
      registrationStatus.value = '报名已截止'
      registrationStatusType.value = 'danger'
      canRegister.value = false
    } else if (now >= registrationStart && now <= registrationEnd) {
      registrationStatus.value = '报名中'
      registrationStatusType.value = 'warning'
      canRegister.value = true
    } else if (now >= startDate) {
      registrationStatus.value = '比赛进行中'
      registrationStatusType.value = 'success'
      canRegister.value = false
    } else if (now < registrationStart) {
      registrationStatus.value = '敬请期待'
      registrationStatusType.value = 'info'
      canRegister.value = false
    }
  } catch (error) {
    console.error('加载赛事详情失败:', error)
    ElMessage.error('加载赛事详情失败')
  } finally {
    loading.value = false
  }
}

// 报名
const handleRegister = () => {
  ElMessage.info('报名功能开发中...')
}

// 分享
const shareCompetition = () => {
  const url = window.location.href
  if (navigator.share) {
    navigator.share({
      title: competition.value.title,
      url: url
    })
  } else {
    ElMessage.success('链接已复制到剪贴板')
    navigator.clipboard.writeText(url)
  }
}

onMounted(() => {
  loadCompetition()
})
</script>

<style scoped>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

.competition-detail {
  min-height: calc(100vh - 345px);
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem 20px;
}

.detail-content {
  min-height: 100%;
}

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 2rem;
  flex-wrap: wrap;
  gap: 1rem;
}

.status-tag {
  font-size: 1.1rem;
  padding: 0.5rem 1.5rem;
}

.header-actions {
  display: flex;
  gap: 1rem;
}

.category-tag {
  font-size: 1rem;
  padding: 0.4rem 1rem;
}

.platform-tag {
  font-size: 0.9rem;
}

.detail-body {
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

.detail-card {
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.card-header h2 {
  font-size: 1.5rem;
  font-weight: 700;
  color: #333;
}

.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 1.5rem;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.info-item.full-width {
  grid-column: 1 / -1;
}

.info-label {
  font-size: 0.9rem;
  font-weight: 600;
  color: #666;
}

.info-value {
  font-size: 1.1rem;
  color: #333;
  font-weight: 500;
}

.info-desc {
  line-height: 1.8;
  color: #444;
  font-size: 1rem;
}

.details-content {
  line-height: 1.8;
  color: #333;
  font-size: 1rem;
}

.details-content :deep() {
  ul, ol {
    margin-left: 1.5rem;
    margin-top: 0.5rem;
    margin-bottom: 0.5rem;
  }

  li {
    margin-bottom: 0.5rem;
  }
}

.registration-actions {
  display: flex;
  gap: 1rem;
  margin-top: 2rem;
  padding-top: 2rem;
  border-top: 1px solid #eee;
}
</style>
