import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  ViewChild,
  computed,
  effect,
  inject,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler,
  ChartConfiguration,
} from 'chart.js';
import { AuthService } from '../../../core/services/auth.service';
import { CashierService } from '../../../core/services/cashier.service';

// Enregistrement des composants nécessaires de Chart.js
Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler
);

export interface CaisseTimelineData {
  labels: string[];
  balances: number[];
  descriptions: string[];
}

@Component({
  selector: 'app-dashboard-manager',
  imports: [RouterLink, MatIconModule],
  templateUrl: './dashboard-manager.html',
  styleUrl: './dashboard-manager.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardManager implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('caisseChartCanvas')
  private readonly caisseChartCanvas?: ElementRef<HTMLCanvasElement>;

  private readonly authService = inject(AuthService);
  private readonly cashierService = inject(CashierService);
  private readonly platformId = inject(PLATFORM_ID);

  public readonly currentUser = this.authService.currentUser;
  public readonly allTransactions = this.cashierService.allTransactions;
  public readonly currentBalance = this.cashierService.currentBalance;

  private chartInstance: Chart | null = null;

  // Préparation réactive des données chronologiques pour Chart.js
  public readonly chartData = computed<CaisseTimelineData>(() => {
    const list = [...this.allTransactions()].sort((a, b) => {
      const dateA = new Date(a.date).getTime() || 0;
      const dateB = new Date(b.date).getTime() || 0;
      return dateA - dateB;
    });

    if (list.length === 0) {
      return {
        labels: ['Départ', 'Aujourd’hui'],
        balances: [0, 0],
        descriptions: ['Solde initial', 'Solde actuel'],
      };
    }

    let runningBalance = 0;
    const labels: string[] = [];
    const balances: number[] = [];
    const descriptions: string[] = [];

    for (const tx of list) {
      runningBalance += tx.montant;
      const parsedDate = new Date(tx.date);
      const formattedDate = !isNaN(parsedDate.getTime())
        ? parsedDate.toLocaleDateString('fr-FR', {
            day: '2-digit',
            month: 'short',
          })
        : tx.date || 'Opération';

      labels.push(formattedDate);
      balances.push(runningBalance);
      descriptions.push(tx.libelle || tx.typeDescription || 'Mouvement de caisse');
    }

    return { labels, balances, descriptions };
  });

  constructor() {
    // Effet réactif mettant à jour Chart.js dès que les données du CashierService changent
    effect(() => {
      const data = this.chartData();
      if (this.chartInstance) {
        this.updateChartData(data);
      }
    });
  }

  public ngOnInit(): void {
    void this.cashierService.loadTransactions();
  }

  public ngAfterViewInit(): void {
    if (isPlatformBrowser(this.platformId) && this.caisseChartCanvas?.nativeElement) {
      this.initChart();
    }
  }

  public ngOnDestroy(): void {
    if (this.chartInstance) {
      this.chartInstance.destroy();
      this.chartInstance = null;
    }
  }

  // Initialisation du graphique natif Chart.js
  private initChart(): void {
    const canvas = this.caisseChartCanvas?.nativeElement;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const data = this.chartData();

    // Dégradé soigné sous la courbe (bleu Transmex)
    const gradient = ctx.createLinearGradient(0, 0, 0, 240);
    gradient.addColorStop(0, 'rgba(30, 58, 138, 0.22)');
    gradient.addColorStop(1, 'rgba(30, 58, 138, 0.0)');

    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels: data.labels,
        datasets: [
          {
            label: 'Solde de caisse',
            data: data.balances,
            borderColor: '#1e3a8a',
            borderWidth: 2.5,
            backgroundColor: gradient,
            fill: true,
            tension: 0.35,
            pointBackgroundColor: '#ffffff',
            pointBorderColor: '#1e3a8a',
            pointBorderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 7,
            pointHoverBackgroundColor: '#1e3a8a',
            pointHoverBorderColor: '#ffffff',
            pointHoverBorderWidth: 2.5,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            titleColor: '#cbd5e1',
            titleFont: { size: 11, weight: 'normal' },
            bodyColor: '#ffffff',
            bodyFont: { size: 13, weight: 'bold' },
            padding: 10,
            cornerRadius: 10,
            displayColors: false,
            callbacks: {
              label: (context) => {
                const val = (context.parsed.y as number) ?? 0;
                const formatted = this.formatCurrency(val);
                const desc = data.descriptions[context.dataIndex];
                return desc ? [`${formatted}`, `• ${desc}`] : `${formatted}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: {
              display: false,
            },
            ticks: {
              color: '#94a3b8',
              font: { size: 11 },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 7,
            },
            border: {
              display: false,
            },
          },
          y: {
            grid: {
              color: '#f1f5f9',
            },
            ticks: {
              color: '#94a3b8',
              font: { size: 11 },
              callback: (value) => {
                const num = Number(value);
                if (Math.abs(num) >= 1000000) {
                  return `${(num / 1000000).toFixed(1)}M`;
                }
                if (Math.abs(num) >= 1000) {
                  return `${Math.round(num / 1000)}k`;
                }
                return num.toString();
              },
            },
            border: {
              display: false,
            },
          },
        },
      },
    };

    this.chartInstance = new Chart(ctx, config);
  }

  // Mise à jour fluide des données du graphique
  private updateChartData(data: CaisseTimelineData): void {
    if (!this.chartInstance) return;
    this.chartInstance.data.labels = data.labels;
    if (this.chartInstance.data.datasets[0]) {
      this.chartInstance.data.datasets[0].data = data.balances;
    }
    this.chartInstance.update('none');
  }

  // Formatage monétaire en FCFA
  public formatCurrency(amount: number): string {
    const formatted = new Intl.NumberFormat('fr-FR', {
      maximumFractionDigits: 0,
    }).format(amount);
    return `${formatted} FCFA`;
  }
}



