<script setup lang="ts">
import { describeOp } from "../lib/recon";
import { useReconStore } from "../store";

const store = useReconStore();
</script>

<template>
  <section class="panel">
    <h2>同步与网络</h2>

    <div class="sync-controls">
      <button type="button" :class="store.online ? 'danger' : ''" @click="store.toggleOnline()">
        {{ store.online ? "断开网络（模拟）" : "恢复网络" }}
      </button>
      <button type="button" class="secondary" :disabled="!store.online" @click="store.syncNow()">
        立即同步 / 重试（{{ store.pendingCount }}）
      </button>
    </div>

    <label class="check">
      <input v-model="store.simulateFailure" type="checkbox" />
      模拟上传失败（响应丢失，重试验证幂等）
    </label>

    <div class="sync-controls">
      <button type="button" class="secondary" @click="store.simulateServerEdit()">模拟中心端改动</button>
      <button type="button" class="secondary" @click="store.resetAll()">重置演示数据</button>
    </div>

    <div class="outbox">
      <h3>待传队列（{{ store.pendingCount }}）</h3>
      <p v-if="store.pendingCount === 0" class="hint">已清空，全部上传成功。</p>
      <ul v-else>
        <li v-for="op in store.local.outbox" :key="op.opId">
          {{ describeOp(op) }}
          <span v-if="op.attempts > 0" class="attempts">已重试 {{ op.attempts }} 次</span>
        </li>
      </ul>
    </div>

    <div class="log-box">
      <h3>同步日志</h3>
      <ul>
        <li v-for="(entry, i) in store.logs" :key="i">
          <span class="log-time">{{ entry.time }}</span>{{ entry.text }}
        </li>
      </ul>
    </div>
  </section>
</template>
