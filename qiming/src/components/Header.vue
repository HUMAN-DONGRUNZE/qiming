<template>
  <header class="sticky top-0 z-40 border-b border-slate-200 bg-white/85 backdrop-blur">
    <div class="flex items-center h-16 mx-auto px-4 justify-center max-w-7xl">
      <router-link to="/" class="item px-2.5 py-2 text-sm font-medium rounded-md transition whitespace-nowrap">首页</router-link>
      <router-link to="/" class="item px-2.5 py-2 text-sm font-medium rounded-md transition whitespace-nowrap">b</router-link>
      <router-link to="/" class="item px-2.5 py-2 text-sm font-medium rounded-md transition whitespace-nowrap">s</router-link>
      <router-link to="/login" class="item px-2.5 py-2 text-sm font-medium rounded-md transition whitespace-nowrap">登录</router-link>
    </div>
  </header>
</template>

<script>
export default {
  name: 'HelloWorld',
  data() {
    return {
      
    }
  }
}
</script>

<style scoped>

.item:hover {
  background-color: #f3f4f6;
  color: black;
}

</style>