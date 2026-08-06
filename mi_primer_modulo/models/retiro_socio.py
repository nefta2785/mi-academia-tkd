from odoo import fields, models


class TaekwondoRetiroSocio(models.Model):
    _name = 'taekwondo.retiro_socio'
    _description = 'Retiro de efectivo de socio'

    quien = fields.Selection(
        selection=[
            ('propio', 'Propio'),
            ('socio', 'Socio'),
        ],
        string='Quién retira',
        required=True,
    )
    fecha = fields.Date(string='Fecha', required=True, default=fields.Date.context_today)
    monto = fields.Float(string='Monto', required=True)
    metodo_pago = fields.Selection(
        selection=[
            ('efectivo', 'Efectivo'),
            ('transferencia', 'Transferencia'),
        ],
        string='Método de pago',
        default='efectivo',
    )
    nota = fields.Char(string='Nota')
