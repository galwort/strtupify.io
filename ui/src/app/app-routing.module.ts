import { NgModule } from '@angular/core';
import { PreloadAllModules, RouterModule, Routes } from '@angular/router';
import { AuthGuard } from './guards/auth.guard';
import { AuthenticatedGuard } from './guards/authenticated.guard';

const routes: Routes = [
  {
    path: '',
    redirectTo: 'home',
    pathMatch: 'full',
  },
  {
    path: 'home',
    loadChildren: () =>
      import('./pages/home/home.module').then((m) => m.HomePageModule),
    canActivate: [AuthenticatedGuard],
  },
  {
    path: 'login',
    loadChildren: () =>
      import('./pages/login/login.module').then((m) => m.LoginPageModule),
    canActivate: [AuthGuard],
  },
  {
    path: 'register',
    loadChildren: () =>
      import('./pages/register/register.module').then(
        (m) => m.RegisterPageModule
      ),
    canActivate: [AuthGuard],
  },
  {
    path: 'application',
    loadChildren: () =>
      import('./pages/application/application.module').then(
        (m) => m.ApplicationPageModule
      ),
    canActivate: [AuthenticatedGuard],
  },
  {
    path: 'company',
    loadChildren: () =>
      import('./pages/company/company.module').then((m) => m.CompanyPageModule),
    canActivate: [AuthenticatedGuard],
  },  {
    path: 'portfolio',
    loadChildren: () => import('./pages/portfolio/portfolio.module').then( m => m.PortfolioPageModule)
  },
  {
    path: 'company-instance',
    loadChildren: () => import('./pages/company-instance/company-instance.module').then( m => m.CompanyInstancePageModule)
  },

];

@NgModule({
  imports: [
    RouterModule.forRoot(routes, { preloadingStrategy: PreloadAllModules }),
  ],
  exports: [RouterModule],
})
export class AppRoutingModule {}
