import { createRouter, createWebHistory } from 'vue-router'
import Home from '../views/Home.vue'
import CompetitionList from '../views/CompetitionList.vue'
import CompetitionDetail from '../views/CompetitionDetail.vue'
import AdminLogin from '../views/admin/AdminLogin.vue'
import AdminDashboard from '../views/admin/AdminDashboard.vue'
import CompetitionManagement from '../views/admin/CompetitionManagement.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'Home',
      component: Home,
      meta: { title: '首页' }
    },
    {
      path: '/competitions',
      name: 'CompetitionList',
      component: CompetitionList,
      meta: { title: '赛事列表' }
    },
    {
      path: '/competitions/:id',
      name: 'CompetitionDetail',
      component: CompetitionDetail,
      meta: { title: '赛事详情' }
    },
    {
      path: '/admin/login',
      name: 'AdminLogin',
      component: AdminLogin,
      meta: { title: '管理员登录' }
    },
    {
      path: '/admin',
      name: 'AdminDashboard',
      component: AdminDashboard,
      meta: { requiresAuth: true }
    },
    {
      path: '/admin/competitions',
      name: 'CompetitionManagement',
      component: CompetitionManagement,
      meta: { requiresAuth: true }
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/'
    }
  ]
})

router.beforeEach((to, from, next) => {
  document.title = to.meta.title ? `${to.meta.title} - 青少年赛事信息聚合平台` : '青少年赛事信息聚合平台'
  
  if (to.meta.requiresAuth && !localStorage.getItem('adminToken')) {
    next('/admin/login')
  } else if (to.path === '/admin/login' && localStorage.getItem('adminToken')) {
    next('/admin')
  } else {
    next()
  }
})

export default router
