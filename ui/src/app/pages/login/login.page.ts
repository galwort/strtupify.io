import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  templateUrl: './login.page.html',
  styleUrls: ['./login.page.scss'],
  standalone: false,
})
export class LoginPage implements OnInit {
  email: string = '';
  password: string = '';

  constructor(private router: Router, private authService: AuthService) {}

  ngOnInit() {}

  emailLogin() {
    this.authService
      .login(this.email, this.password)
      .then(() => {
        this.router.navigate(['/home']);
      })
      .catch((error) => {
        console.error(error);
      });
  }

  googleLogin() {
    this.authService
      .loginWithGoogle()
      .then(() => {
        this.router.navigate(['/home']);
      })
      .catch((error) => {
        console.error(error);
      });
  }
}
