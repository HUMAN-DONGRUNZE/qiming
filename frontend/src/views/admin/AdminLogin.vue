<template>
  <div class="admin-login-container">
    <el-card class="login-card">
      <template #header>
        <div class="card-header">
          <h2>管理员登录</h2>
        </div>
      </template>

      <el-form :model="loginForm" :rules="rules" ref="loginFormRef">
        <el-form-item prop="username">
          <el-input
            v-model="loginForm.username"
            placeholder="请输入用户名"
            :prefix-icon="User"
            size="large"
          />
        </el-form-item>

        <el-form-item prop="password">
          <el-input
            v-model="loginForm.password"
            type="password"
            placeholder="请输入密码"
            :prefix-icon="Lock"
            size="large"
            show-password
          />
        </el-form-item>

        <el-form-item>
          <el-button type="primary" size="large" @click="handleLogin" :loading="loading" style="width: 100%">
            登录
          </el-button>
        </el-form-item>
      </el-form>

      <div class="tips">
        <p>默认账号: admin / 123456</p>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { User, Lock } from '@element-plus/icons-vue'

const router = useRouter()
const loginFormRef = ref(null)
const loading = ref(false)

loginForm = {
  username: '',
  password: ''
}

rules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, max: 20, message: '用户名长度3-20个字符', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码长度至少6个字符', trigger: 'blur' }
  ]
}

const handleLogin = async () => {
  if (!loginFormRef.value) return

  try {
    const valid = await loginFormRef.value.validate()
    if (!valid) return

    loading.value = true

    // 模拟登录 - 后端实现
    if (loginForm.value.username === 'admin' && loginForm.value.password === 'admin123') {
      localStorage.setItem('adminToken', 'fake-token-for-demo')
      ElMessage.success('登录成功')
      router.push('/admin')
    } else if (loginForm.value.username === 'admin' && loginForm.value.password === '123456') {
      localStorage.setItem('adminToken', 'fake-token-for-demo')
      ElMessage.success('登录成功')
      router.push('/admin')
    } else {
      ElMessage.error('用户名或密码错误')
    }
  } catch (error) {
    console.error('登录验证失败:', error)
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

.admin-login-container {
  min-height: calc(100vh - 345px);
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  padding: 2rem;
}

.login-card {
  width: 100%;
  max-width: 450px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.2);
}

.card-header {
  text-align: center;
}

.card-header h2 {
  font-size: 1.8rem;
  color: #333;
  margin-bottom: 0;
}

.tips {
  text-align: center;
  color: #999;
  font-size: 0.9rem;
  margin-top: 1rem;
}

.tips p {
  margin-bottom: 0.5rem;
}
</style>
