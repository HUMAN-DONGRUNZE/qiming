<template>
  <div class="home">
    <!-- 顶部导航栏 -->
    <header class="header">
      <div class="header-content">
        <div class="logo">
          <span class="logo-text">青少年赛事信息聚合平台</span>
        </div>
        <nav class="nav">
          <router-link to="/" class="nav-item">首页</router-link>
          <router-link to="/competitions" class="nav-item">赛事列表</router-link>
          <router-link to="/admin" class="nav-item admin-nav">管理后台</router-link>
        </nav>
      </div>
    </header>

    <!-- 英雄区域 -->
    <section class="hero">
      <div class="hero-content">
        <h1 class="hero-title">发现适合您的青少年赛事</h1>
        <p class="hero-subtitle">一站式赛事信息聚合平台，汇聚各类精彩赛事</p>
        <div class="hero-actions">
          <el-button type="primary" size="large" @click="$router.push('/competitions')">
            浏览赛事
          </el-button>
          <el-button size="large" @click="scrollToCompetitions">
            查看最新赛事
          </el-button>
        </div>
      </div>
    </section>

    <!-- 赛事分类 -->
    <section class="categories">
      <div class="container">
        <h2 class="section-title">赛事分类</h2>
        <div class="category-grid">
          <div
            v-for="category in categories"
            :key="category.id"
            class="category-card"
            @click="goToCategory(category.id)"
          >
            <div class="category-icon">{{ category.icon }}</div>
            <h3>{{ category.name }}</h3>
            <p>{{ category.count }} 个赛事</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 最新赛事 -->
    <section id="competitions" class="competitions">
      <div class="container">
        <div class="section-header">
          <h2 class="section-title">最新赛事</h2>
          <router-link to="/competitions" class="more-link">
            查看更多 <el-icon><arrow-right /></el-icon>
          </router-link>
        </div>

        <div class="competition-list">
          <div
            v-for="competition in latestCompetitions"
            :key="competition.id"
            class="competition-card"
            @click="viewCompetition(competition.id)"
          >
            <div class="competition-top">
              <el-tag :type="getTagType(competition.status)" size="small">
                {{ competition.status }}
              </el-tag>
              <el-tag type="info" size="small">
                {{ competition.category }}
              </el-tag>
            </div>
            <h3 class="competition-title">{{ competition.title }}</h3>
            <p class="competition-desc">{{ competition.description }}</p>
            <div class="competition-info">
              <el-icon><calendar /></el-icon>
              <span>{{ competition.startDate }}</span>
            </div>
            <div class="competition-info">
              <el-icon><location /></el-icon>
              <span>{{ competition.location }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 统计数据 -->
    <section class="stats">
      <div class="container">
        <div class="stats-grid">
          <div class="stat-item">
            <div class="stat-number">{{ stats.total }}</div>
            <div class="stat-label">赛事总数</div>
          </div>
          <div class="stat-item">
            <div class="stat-number">{{ stats.categorized }}</div>
            <div class="stat-label">赛事分类</div>
          </div>
          <div class="stat-item">
            <div class="stat-number">{{ stats.platforms }}</div>
            <div class="stat-label">数据来源</div>
          </div>
          <div class="stat-item">
            <div class="stat-number">{{ stats.updates }}</div>
            <div class="stat-label">今日更新</div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowRight } from '@element-plus/icons-vue'
import { fetchLatestCompetitions } from '@/api/competition'

const router = useRouter()

// 赛事分类
const categories = ref([
  { id: 1, name: '科技创新', icon: '🚀', count: 45 },
  { id: 2, name: '体育竞技', icon: '⚽', count: 38 },
  { id: 3, name: '艺术文化', icon: '🎨', count: 52 },
  { id: 4, name: '学术竞赛', icon: '📚', count: 67 },
  { id: 5, name: '创客动手', icon: '🔧', count: 28 },
  { id: 6, name: '户外探索', icon: '🏕️', count: 35 }
])

// 最新赛事
const latestCompetitions = ref([])
const logoLoadError = ref(false)

// 统计数据
const stats = ref({
  total: 0,
  categorized: 6,
  platforms: 8,
  updates: 0
})

// 获取最新赛事
const loadCompetitions = async () => {
  try {
    const response = await fetchLatestCompetitions()
    latestCompetitions.value = response.data.slice(0, 4)
    stats.value.total = response.data.length
    stats.value.updates = Math.floor(Math.random() * 10) + 5
  } catch (error) {
    console.error('加载赛事失败:', error)
  }
}

// 获取标签类型
const getTagType = (status) => {
  const types = {
    '招募中': 'success',
    '报名中': 'warning',
    '即将开始': 'info',
    '已结束': 'danger'
  }
  return types[status] || 'info'
}

// 查看赛事
const viewCompetition = (id) => {
  router.push(`/competitions/${id}`)
}

// 跳转分类
const goToCategory = (id) => {
  router.push(`/competitions?category=${id}`)
}

// 滚动到赛事区
const scrollToCompetitions = () => {
  const element = document.getElementById('competitions')
  if (element) {
    element.scrollIntoView({ behavior: 'smooth' })
  }
}

onMounted(() => {
  loadCompetitions()
})
</script>

<style scoped>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

.home {
  min-height: 100%;
}

/* 顶部导航栏 */
.header {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 1rem 0;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
}

.header-content {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.logo {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.logo-text {
  font-size: 1.5rem;
  font-weight: bold;
}

.nav {
  display: flex;
  gap: 2rem;
}

.nav-item {
  color: rgba(255, 255, 255, 0.9);
  text-decoration: none;
  font-weight: 500;
  padding: 0.5rem 1rem;
  border-radius: 8px;
  transition: all 0.3s;
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.15);
}

.admin-nav {
  background: rgba(255, 255, 255, 0.2);
}

.admin-nav:hover {
  background: rgba(255, 255, 255, 0.3);
}

/* 英雄区域 */
.hero {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 6rem 0;
  text-align: center;
}

.hero-content {
  max-width: 800px;
  margin: 0 auto;
}

.hero-title {
  font-size: 3rem;
  margin-bottom: 1rem;
  font-weight: 800;
  line-height: 1.2;
}

.hero-subtitle {
  font-size: 1.25rem;
  margin-bottom: 2rem;
  opacity: 0.9;
}

.hero-actions {
  display: flex;
  gap: 1rem;
  justify-content: center;
}

/* 通用区域样式 */
.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 20px;
}

.section-title {
  font-size: 2rem;
  margin-bottom: 2rem;
  font-weight: 700;
  text-align: center;
}

/* 赛事分类 */
.categories {
  padding: 4rem 0;
  background: white;
}

.category-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 2rem;
}

.category-card {
  background: white;
  border-radius: 16px;
  padding: 2rem;
  text-align: center;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
  border: 1px solid #eee;
  cursor: pointer;
  transition: all 0.3s;
}

.category-card:hover {
  transform: translateY(-8px);
  box-shadow: 0 8px 30px rgba(102, 126, 234, 0.15);
}

.category-icon {
  font-size: 4rem;
  margin-bottom: 1rem;
}

.category-card h3 {
  margin-bottom: 0.5rem;
  color: #333;
}

.category-card p {
  color: #666;
  font-size: 0.9rem;
}

/* 赛事列表 */
.competitions {
  padding: 4rem 0;
  background: white;
}

.competition-list {
  display: grid;
  gap: 1.5rem;
}

.competition-card {
  background: white;
  border-radius: 12px;
  padding: 1.5rem;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
  cursor: pointer;
  transition: all 0.3s;
  border-left: 4px solid #667eea;
}

.competition-card:hover {
  box-shadow: 0 8px 25px rgba(0, 0, 0, 0.1);
  transform: translateX(4px);
}

.competition-top {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.competition-title {
  font-size: 1.25rem;
  margin-bottom: 0.5rem;
  color: #333;
  font-weight: 600;
}

.competition-desc {
  color: #666;
  margin-bottom: 1rem;
  line-height: 1.5;
}

.competition-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #888;
  font-size: 0.9rem;
}

/* 统计数据 */
.stats {
  padding: 4rem 0;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 2rem;
}

.stat-item {
  text-align: center;
}

.stat-number {
  font-size: 3rem;
  font-weight: 800;
  margin-bottom: 0.5rem;
}

.stat-label {
  font-size: 1.1rem;
  opacity: 0.9;
}

/* 底部 */
footer {
  background: #2c3e50;
  color: white;
  padding: 2rem 0;
  text-align: center;
}

.footer-text {
  color: rgba(255, 255, 255, 0.7);
}
</style>
