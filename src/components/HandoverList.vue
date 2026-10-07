<script setup lang="ts">
import { computed, ref } from "vue";
import { BASE_STATUSES, CONFLICT_STATUS, formatMoney, formatTime, readingVolume, type HandoverSnapshot } from "../lib/recon";
import { useReconStore } from "../store";

const store = useReconStore();

const shiftFilter = ref("全部班次");
const statusFilter = ref("全部状态");
const statusOptions = computed(() => ["全部状态", ...BASE_STATUSES, CONFLICT_STATUS]);

const filtered = computed(() =>
  store.rows.filter((r) => {
    if (shiftFilter.value !== "全部班次" && r.shift !== shiftFilter.value) return false;
    if (statusFilter.value !== "全部状态" && r.displayStatus !== statusFilter.value) return false;
    return true;
  })
);

function snapshotLines(s: HandoverSnapshot) {
  return [
    `状态：${s.status}`,
    `销量：${s.readings.reduce((sum, r) => sum + readingVolume(r), 0).toFixed(2)} L`,
    `销售额：¥${formatMoney(s.salesAmount)}`,
    `备注：${s.notes}`,
    `版本 v${s.version} · ${s.origin} · ${formatTime(s.updatedAt)}`,
  ];
}
</script>

<template>
  <section class="list-panel">
    <div class="toolbar">
      <h2>交接单列表</h2>
      <div class="filters">
        <select v-model="shiftFilter">
          <option>全部班次</option>
          <option>早班</option>
          <option>中班</option>
          <option>晚班</option>
        </select>
        <select v-model="statusFilter">
          <option v-for="s in statusOptions" :key="s">{{ s }}</option>
        </select>
      </div>
    </div>

    <div class="record-grid">
      <div v-if="filtered.length === 0" class="empty">暂无匹配数据</div>

      <article v-for="row in filtered" :key="row.id" class="record" :class="{ conflicted: row.conflictPending }">
        <div class="record-head">
          <p class="record-title">{{ row.shiftDate }} {{ row.shift }}</p>
          <div class="badges">
            <span class="status" :class="`st-${row.displayStatus}`">{{ row.displayStatus }}</span>
            <span class="sync-badge" :class="{ pending: row.syncState === '待传', conflict: row.syncState === '冲突待核' }">
              {{ row.syncState }}
            </span>
          </div>
        </div>

        <div class="amounts">
          <span>销量 <strong>{{ row.volume.toFixed(2) }}</strong> L</span>
          <span>销售额 <strong>¥{{ formatMoney(row.sales) }}</strong></span>
          <span>实收 <strong>¥{{ formatMoney(row.received) }}</strong></span>
          <span :class="{ 'diff-bad': Math.abs(row.diff) >= 0.005 }">
            差异 <strong>¥{{ formatMoney(row.diff) }}</strong>
          </span>
        </div>

        <template v-if="store.handoverOf(row.id)">
          <table v-if="store.handoverOf(row.id)!.readings.length" class="mini-table">
            <thead>
              <tr><th>油枪</th><th>油品</th><th>起</th><th>止</th><th>销量(L)</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in store.handoverOf(row.id)!.readings" :key="r.id">
                <td>{{ r.pumpNo }}</td>
                <td>{{ r.fuelType }}</td>
                <td>{{ r.start }}</td>
                <td>{{ r.end }}</td>
                <td>{{ readingVolume(r).toFixed(2) }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <p class="note">
          {{ row.notes }}
          <span v-if="row.recalcMark" class="recalc-mark">已于 {{ formatTime(row.recalcMark) }} 按新油价重算</span>
        </p>

        <div v-if="store.handoverOf(row.id)?.conflict" class="conflict-box">
          <p class="conflict-title">双端均有改动，两版并存，请站长核对（站内已复核值未被覆盖）：</p>
          <div class="conflict-cols">
            <div class="conflict-col">
              <strong>站内版</strong>
              <p v-for="(line, i) in snapshotLines(store.handoverOf(row.id)!.conflict!.local)" :key="i">{{ line }}</p>
              <button type="button" @click="store.resolve(row.id, 'local')">采用站内版</button>
            </div>
            <div class="conflict-col">
              <strong>中心版（迟到副本）</strong>
              <p v-for="(line, i) in snapshotLines(store.handoverOf(row.id)!.conflict!.remote)" :key="i">{{ line }}</p>
              <button type="button" class="secondary" @click="store.resolve(row.id, 'remote')">采用中心版</button>
            </div>
          </div>
        </div>

        <div class="actions">
          <button v-if="row.baseStatus === '待复核' && !row.conflictPending" type="button" @click="store.review(row.id)">
            复核
          </button>
          <button
            v-if="row.baseStatus !== '待复核' && !row.conflictPending"
            type="button"
            class="secondary"
            @click="store.reopen(row.id)"
          >
            重新打开
          </button>
          <span class="meta">v{{ row.version }} · 更新 {{ formatTime(row.updatedAt) }}</span>
          <button type="button" class="danger" @click="store.removeHandover(row.id)">删除</button>
        </div>
      </article>
    </div>
  </section>
</template>
