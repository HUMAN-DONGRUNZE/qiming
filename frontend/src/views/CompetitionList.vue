<template>
  <div class="competition-list-page">
    <header class="page-header">
      <h1>赛事列表</h1>
      <el-input
        v-model="searchQuery"
        placeholder="搜索赛事..."
        clearable
        style="width: 300px"
        @clear="handleSearch"
      />
    </header>

    <div class="page-content">
      <!-- 筛选器 -->
      <el-card class="filter-card">
        <el-form :model="filters" inline>
          <el-form-item label="赛事状态">
            <el-select v-model="filters.status" @change="handleFilter" clearable placeholder="全部状态">
              <el-option label="招募中" value="招募中" />
              <el-option label="报名中" value="报名中" />
              <el-option label="即将开始" value="即将开始" />
              <el-option label="已结束" value="已结束" />
            </el-select>
          </el-form-item>
          <el-form-item label="赛事分类">
            <el-select v-model="filters.category" @change="handleFilter" clearable>
              <el-option v-for="cat in categories" :key="cat.id" :label="cat.name" :value="cat.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="地区">
            <el-select v-model="filters.region" @change="handleFilter" clearable>
              <el-option label="全部地区" value="" />
              <el-option label="北京" value="北京" />
              <el-option label="上海" value="上海" />
              <el-option label="广州" value="广州" />
              <el-option label="深圳" value="深圳" />
              <el-option label="杭州" value="杭州" />
              <el-option label="成都" value="成都" />
            </el-select>
          </el-form-item>
          <el-form-item label="时间范围">
            <el-date-picker
              v-model="dateRange"
              type="daterange"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              @change="handleFilter"
              clearable
            />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="handleSearch">搜索</el-button>
            <el-button @click="resetFilters">重置</el-button>
          </el-form-item>
        </el-form>
      </el-card>

      <!-- 赛事列表 -->
      <div class="competitions">
        <div
          v-for="competition in competitions"
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
          <div class="competition-info-grid">
            <div class="info-item">
              <el-icon><calendar /></el-icon>
              <span>{{ competition.startDate }}</span>
            </div>
            <div class="info-item">
              <el-icon><location /></el-icon>
              <span>{{ competition.location }}</span>
            </div>
            <div class="info-item">
              <el-icon><user /></el-icon>
              <span>{{ competition.participants }} 人报名</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 分页 -->
      <div class="pagination">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 30, 50]"
          :total="total"
          layout="total, sizes, prev, pager, next, jumper"
          @size-change="loadCompetitions"
          @current-change="loadCompetitions"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { fetchCompetitions, createCompetitionURL } from '@/api/competition'
import { Calendar, Location, User } from '@element-plus/icons-vue'

const router = useRouter()

// 数据
const competitions = ref([])
const categories = ref([
  { id: 1, name: '科技创新' },
  { id: 2, name: '体育竞技' },
  { id: 3, name: '艺术文化' },
  { id: 4, name: '学术竞赛' },
  { id: 5, name: '创客动手' },
  { id: 6, name: '户外探索' }
])

// 搜索和筛选
const searchQuery = ref('')
const filters = ref({
  status: '',
  category: '',
  region: ''
})
const dateRange = ref([])
const currentPage = ref(1)
const pageSize = ref(10)
const total = ref(0)

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

// 加载赛事
const loadCompetitions = async () => {
  try {
    const params = {
      page: currentPage.value,
      size: pageSize.value,
      ...filters.value
    }
    if (searchQuery.value) {
      params.search = searchQuery.value
    }
    if (dateRange.value && dateRange.value.length === 2) {
      params.startDate = dateRange.value[0]
      params.endDate = dateRange.value[1]
    }

    const response = await fetchCompetitions(params)
    competitions.value = response.data.items || response.data
    total.value = response.data.total || 0
  } catch (error) {
    console.error('加载赛事失败:', error)
  }
}

// 搜索
const handleSearch = () => {
  currentPage.value = 1
  loadCompetitions()
}

// 筛选
const handleFilter = () => {
  currentPage.value = 1
  loadCompetitions()
}

// 重置筛选
const resetFilters = () => {
  searchQuery.value = ''
  filters.value = {
    status: '',
    category: '',
    region: ''
  }
  dateRange.value = []
  loadCompetitions()
}

// 查看赛事详情
const viewCompetition = (id) => {
  router.push(`/competitions/${id}`)
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

.competition-list-page {
  min-height: calc(100vh - 345px);
  max-width: 1400px;
  margin: 0 auto;
  padding: 2rem 20px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2rem;
}

.page-header h1 {
  font-size: 2rem;
  font-weight: 700;
  color: #333;
}

.page-content {
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

.filter-card {
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
}

.competitions {
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

.competition-info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
}

.info-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #888;
  font-size: 0.9rem;
}

.pagination {
  display: flex;
  justify-content: center;
  margin-top: 2rem;
}
</style>
