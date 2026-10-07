<template>
  <div class="competition-management">
    <el-card class="management-card">
      <template #header>
        <div class="card-header">
          <div class="header-title">
            <h2>赛事管理</h2>
            <div class="header-actions">
              <el-input
                v-model="searchQuery"
                placeholder="搜索赛事..."
                clearable
                style="width: 250px"
                @clear="handleSearch"
              ></el-input>
              <el-button type="primary" @click="showAddModal" :icon="Plus">
                添加赛事
              </el-button>
              <el-button @click="handleRefresh">
                <el-icon><Refresh /></el-icon>
                刷新
              </el-button>
            </div>
          </div>
        </div>
      </template>

      <!-- 筛选器 -->
      <div class="filters">
        <el-select v-model="filters.status" @change="handleFilter" clearable placeholder="全部状态">
          <el-option label="招募中" value="招募中" />
          <el-option label="报名中" value="报名中" />
          <el-option label="即将开始" value="即将开始" />
          <el-option label="已结束" value="已结束" />
        </el-select>
        <el-select v-model="filters.category" @change="handleFilter" clearable placeholder="全部分类">
          <el-option v-for="cat in categories" :key="cat.id" :label="cat.name" :value="cat.id" />
        </el-select>
        <el-date-picker
          v-model="dateRange"
          type="daterange"
          range-separator="至"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          @change="handleFilter"
          clearable
        />
      </div>

      <!-- 数据表格 -->
      <el-table :data="competitions" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="title" label="赛事名称" min-width="200" />
        <el-table-column prop="category" label="分类" width="120" />
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="getStatusType(row.status)" size="small">
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="startDate" label="开始日期" width="120" />
        <el-table-column prop="location" label="地点" width="150" />
        <el-table-column prop="participants" label="报名人数" width="100">
          <template #default="{ row }">
            {{ row.participants || 0 }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" size="small" @click="showEditModal(row)">
              编辑
            </el-button>
            <el-button type="danger" size="small" @click="handleDelete(row)">
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>

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
    </el-card>

    <!-- 添加/编辑赛事对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEditMode ? '编辑赛事' : '添加赛事'"
      width="800px"
    >
      <el-form :model="competitionForm" :rules="rules" ref="formRef" label-width="120px">
        <el-form-item label="赛事标题" prop="title">
          <el-input v-model="competitionForm.title" placeholder="请输入赛事标题" />
        </el-form-item>

        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="赛事分类" prop="category">
              <el-select v-model="competitionForm.category" placeholder="请选择分类" style="width: 100%">
                <el-option v-for="cat in categories" :key="cat.id" :label="cat.name" :value="cat.name" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="赛事状态" prop="status">
              <el-select v-model="competitionForm.status" placeholder="请选择状态" style="width: 100%">
                <el-option label="招募中" value="招募中" />
                <el-option label="报名中" value="报名中" />
                <el-option label="即将开始" value="即将开始" />
                <el-option label="已结束" value="已结束" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="开始日期" prop="startDate">
              <el-date-picker
                v-model="competitionForm.startDate"
                type="date"
                placeholder="选择开始日期"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="结束日期" prop="endDate">
              <el-date-picker
                v-model="competitionForm.endDate"
                type="date"
                placeholder="选择结束日期"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="报名开始" prop="registrationStartDate">
              <el-date-picker
                v-model="competitionForm.registrationStartDate"
                type="date"
                placeholder="选择报名开始日期"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="报名截止" prop="registrationEndDate">
              <el-date-picker
                v-model="competitionForm.registrationEndDate"
                type="date"
                placeholder="选择报名截止日期"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="举办地点" prop="location">
          <el-input v-model="competitionForm.location" placeholder="请输入举办地点" />
        </el-form-item>

        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="报名费用" prop="registrationFee">
              <el-input v-model="competitionForm.registrationFee" placeholder="请输入报名费用" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="组织单位" prop="organizer">
              <el-input v-model="competitionForm.organizer" placeholder="请输入组织单位" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="赛事描述" prop="description">
          <el-input
            v-model="competitionForm.description"
            type="textarea"
            :rows="3"
            placeholder="请输入赛事描述"
          />
        </el-form-item>

        <el-form-item label="赛事详情" prop="details">
          <el-input
            v-model="competitionForm.details"
            type="textarea"
            :rows="6"
            placeholder="请输入赛事详情（支持HTML格式）"
          />
        </el-form-item>

        <el-form-item label="报名方式" prop="registrationMethod">
          <el-input
            v-model="competitionForm.registrationMethod"
            type="textarea"
            :rows="2"
            placeholder="请输入报名方式"
          />
        </el-form-item>
      </el-form>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" @click="handleSubmit" :loading="submitting">确定</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh } from '@element-plus/icons-vue'
import { fetchCompetitions, createCompetition, updateCompetition, deleteCompetition } from '@/api/competition'

const loading = ref(false)
const submitting = ref(false)
const competitions = ref([])
const categories = ref([
  { id: 1, name: '科技创新' },
  { id: 2, name: '体育竞技' },
  { id: 3, name: '艺术文化' },
  { id: 4, name: '学术竞赛' },
  { id: 5, name: '创客动手' },
  { id: 6, name: '户外探索' }
])

const searchQuery = ref('')
const filters = ref({ status: '', category: '' })
const dateRange = ref([])
const currentPage = ref(1)
const pageSize = ref(10)
const total = ref(0)

const dialogVisible = ref(false)
const isEditMode = ref(false)
const formRef = ref(null)

const competitionForm = ref({
  title: '',
  category: '',
  status: '',
  startDate: '',
  endDate: '',
  registrationStartDate: '',
  registrationEndDate: '',
  location: '',
  registrationFee: '',
  organizer: '',
  description: '',
  details: '',
  registrationMethod: ''
})

const rules = {
  title: [{ required: true, message: '请输入赛事标题', trigger: 'blur' }],
  category: [{ required: true, message: '请选择赛事分类', trigger: 'change' }],
  status: [{ required: true, message: '请选择赛事状态', trigger: 'change' }],
  startDate: [{ required: true, message: '请选择开始日期', trigger: 'change' }],
  endDate: [{ required: true, message: '请选择结束日期', trigger: 'change' }],
  registrationStartDate: [{ required: true, message: '请选择报名开始日期', trigger: 'change' }],
  registrationEndDate: [{ required: true, message: '请选择报名截止日期', trigger: 'change' }],
  location: [{ required: true, message: '请输入举办地点', trigger: 'blur' }]
}

const getStatusType = (status) => {
  const types = {
    '招募中': 'success',
    '报名中': 'warning',
    '即将开始': 'info',
    '已结束': 'danger'
  }
  return types[status] || 'info'
}

const loadCompetitions = async () => {
  try {
    loading.value = true
    const params = {
      page: currentPage.value,
      size: pageSize.value,
      ...filters.value
    }
    if (searchQuery.value) params.search = searchQuery.value

    const response = await fetchCompetitions(params)
    competitions.value = response.data.items || response.data
    total.value = response.data.total || 0
  } catch (error) {
    ElMessage.error('加载赛事列表失败')
  } finally {
    loading.value = false
  }
}

const handleSearch = () => { currentPage.value = 1; loadCompetitions() }
const handleFilter = () => { currentPage.value = 1; loadCompetitions() }

const handleRefresh = () => {
  ElMessage.info('刷新成功')
  loadCompetitions()
}

const showAddModal = () => {
  isEditMode.value = false
  resetForm()
  dialogVisible.value = true
}

const showEditModal = (row) => {
  isEditMode.value = true
  competitionForm.value = { ...row }
  dialogVisible.value = true
}

const resetForm = () => {
  if (formRef.value) formRef.value.resetFields()
  competitionForm.value = {
    title: '',
    category: '',
    status: '',
    startDate: '',
    endDate: '',
    registrationStartDate: '',
    registrationEndDate: '',
    location: '',
    registrationFee: '',
    organizer: '',
    description: '',
    details: '',
    registrationMethod: ''
  }
}

const handleSubmit = async () => {
  if (!formRef.value) return

  try {
    const valid = await formRef.value.validate()
    if (!valid) return

    submitting.value = true

    const data = { ...competitionForm.value }

    if (isEditMode.value) {
      data.id = competitions.value.find(c => c.title === data.title)?.id
      await updateCompetition(data.id, data)
      ElMessage.success('更新成功')
    } else {
      await createCompetition(data)
      ElMessage.success('添加成功')
    }

    dialogVisible.value = false
    loadCompetitions()
  } catch (error) {
    console.error('提交失败:', error)
  } finally {
    submitting.value = false
  }
}

const handleDelete = async (row) => {
  try {
    await ElMessageBox.confirm('确定要删除这个赛事吗？', '提示', {
      type: 'warning'
    })
    await deleteCompetition(row.id)
    ElMessage.success('删除成功')
    loadCompetitions()
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('删除失败')
    }
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

.competition-management {
  min-height: calc(100vh - 345px);
  padding: 2rem 0;
}

.management-card {
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-title h2 {
  font-size: 1.5rem;
  color: #333;
}

.header-actions {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  align-items: center;
}

.filters {
  display: flex;
  gap: 1rem;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
}

.pagination {
  display: flex;
  justify-content: center;
  margin-top: 2rem;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 1rem;
}
</style>
